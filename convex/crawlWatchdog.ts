import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { transitionRun } from "./runState";

/**
 * Crawl watchdog.
 *
 * A run parks in `wait` when it starts a durable Firecrawl crawl and is woken
 * by that crawl's completion callback (`researchStore.crawlCompleted` →
 * `completeCrawl`, which moves the run wait → evaluate). If the callback never
 * arrives — Firecrawl refuses the host (robots.txt), the job dies provider-side,
 * or the webhook is simply lost — the run stays `waiting` forever while the
 * sources it already stored sit unused. The command center then reports a run
 * that is "waiting" when nothing will ever wake it: the same class of lie the
 * stale-run reaper exists to prevent, one state later.
 *
 * A crawl is the *only* reason a run legitimately parks in `wait` without an
 * interruption, and the run's latest recorded event is what distinguishes it
 * from the other `wait` producer — an approved send waiting on a counterpart's
 * reply (`action.sent`). This sweep therefore resumes exactly the runs whose
 * latest event is `crawl.awaiting`. A reply wait is never touched: only the
 * counterpart can end that one.
 *
 * Resuming is safe and cheap. `awaitCrawl` marks the crawl query `done` before
 * parking, so the resumed `evaluate` stage finds an empty backlog, resolves the
 * sources already stored into entities, explains matches, and moves to approval.
 * If the crawl callback lands *after* the sweep, `completeCrawl` is a no-op
 * because the run is no longer in `wait`.
 *
 * A timed-out crawl with nothing stored is a real failure, so it is parked as
 * `blocked` with `activeInterruption: "crawl_timed_out"` — visible and resumable
 * — rather than advancing to an approval screen with nothing to approve.
 */

/**
 * How long a crawl may run without any recorded progress before Radar stops
 * waiting for it. Durable crawls finish in minutes; this is deliberately
 * generous so a slow-but-healthy crawl is never pre-empted.
 */
export const CRAWL_WAIT_MS = 20 * 60 * 1000;

/** Bound on how many runs one sweep inspects, so the sweep stays cheap. */
const SWEEP_LIMIT = 200;

/** How many stored sources to count before reporting "50+". */
const SOURCE_SAMPLE_LIMIT = 51;

export const resumeStalledCrawls = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), resumed: v.number(), blocked: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - CRAWL_WAIT_MS;
    const waitedMinutes = Math.round(CRAWL_WAIT_MS / 60000);

    const waiting = await ctx.db
      .query("agentRuns")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .take(SWEEP_LIMIT);

    let resumed = 0;
    let blocked = 0;

    for (const run of waiting) {
      if (run.updatedAt > cutoff) continue;
      // `wait` is shared with approved sends waiting on a reply; the event
      // check below is what separates them.
      if (run.currentStage !== "wait") continue;

      const latest = await ctx.db
        .query("runEvents")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .order("desc")
        .first();
      if (!latest || latest.type !== "crawl.awaiting") continue;

      const stored = await ctx.db
        .query("sourceRecords")
        .withIndex("by_missionId", (q) => q.eq("missionId", run.missionId))
        .take(SOURCE_SAMPLE_LIMIT);
      const storedLabel = stored.length >= SOURCE_SAMPLE_LIMIT ? `${SOURCE_SAMPLE_LIMIT - 1}+` : String(stored.length);

      if (stored.length === 0) {
        await ctx.db.insert("runSteps", {
          missionId: run.missionId,
          runId: run._id,
          stage: "wait",
          label: "crawl.timed_out",
          summary: `No crawl completion callback arrived within ${waitedMinutes} minutes and nothing was stored, so Radar stopped waiting. Retry the stage or adjust the discovery strategy.`,
          reference: latest.safeSummary,
          errorCode: "CRAWL_TIMED_OUT",
          tool: "crawlWatchdog",
          createdAt: now,
        });
        try {
          await transitionRun(ctx, {
            missionId: run.missionId,
            targetStage: "wait",
            targetStatus: "blocked",
            interruption: "crawl_timed_out",
            eventType: "crawl.timed_out",
            safeSummary: `The durable crawl did not report back within ${waitedMinutes} minutes and stored nothing. Radar stopped waiting instead of hanging.`,
          });
          blocked += 1;
        } catch {
          // A late callback or a user action already moved the run on.
        }
        continue;
      }

      await ctx.db.insert("runSteps", {
        missionId: run.missionId,
        runId: run._id,
        stage: "wait",
        label: "crawl.timed_out",
        summary: `No crawl completion callback arrived within ${waitedMinutes} minutes, so Radar resumed with the ${storedLabel} source${storedLabel === "1" ? "" : "s"} it had already stored instead of hanging.`,
        reference: latest.safeSummary,
        errorCode: "CRAWL_TIMED_OUT",
        tool: "crawlWatchdog",
        createdAt: now,
      });

      try {
        await transitionRun(ctx, {
          missionId: run.missionId,
          targetStage: "evaluate",
          targetStatus: "active",
          interruption: null,
          eventType: "crawl.timed_out",
          safeSummary: `The crawl did not report back within ${waitedMinutes} minutes; Radar resumed with the ${storedLabel} source${storedLabel === "1" ? "" : "s"} already stored.`,
        });
        await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: run.missionId });
        resumed += 1;
      } catch {
        // A late callback won the race and already advanced the run.
      }
    }

    return { scanned: waiting.length, resumed, blocked };
  },
});
