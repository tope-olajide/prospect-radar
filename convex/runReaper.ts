import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { transitionRun } from "./runState";

/**
 * Stale-run reaper.
 *
 * A run only advances because a stage either schedules its successor or is
 * waiting on an external callback. If a stage dies without transitioning
 * (a provider call made outside the orchestrator's try/catch, a scheduled
 * continuation that never fired), the row stays `active` forever and the
 * command center keeps reporting it as work in progress — which is a lie about
 * the system's own state.
 *
 * The reaper parks those runs as `blocked` with `activeInterruption: "stale_run"`.
 * Parking rather than failing is deliberate: `blocked` is the one state the
 * existing retry control can resume from, so an abandoned run becomes a
 * one-click recovery instead of a dead mission. Runs that are legitimately
 * parked (`waiting` on a crawl, `blocked` on a classified failure, or terminal)
 * and runs that simply have not been started (`queued`) are never touched.
 */

/**
 * How long a run may stay `active` without any state change before it is
 * considered abandoned. Orchestrated stages take seconds to a couple of
 * minutes; a durable crawl parks the run in `waiting`, not `active`.
 */
export const STALE_RUN_MS = 30 * 60 * 1000;

/** Bound on how many runs one sweep inspects, so the sweep stays cheap. */
const SWEEP_LIMIT = 200;

export const reap = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), reaped: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_RUN_MS;

    const active = await ctx.db
      .query("agentRuns")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(SWEEP_LIMIT);

    let reaped = 0;
    for (const run of active) {
      if (run.updatedAt > cutoff) continue;

      // Record the reason before the transition, so the receipt always exists
      // even if a concurrent state change wins the race.
      await ctx.db.insert("runSteps", {
        missionId: run.missionId,
        runId: run._id,
        stage: run.currentStage,
        label: "run.reaped",
        summary: `This run held stage ${run.currentStage} for over ${Math.round(STALE_RUN_MS / 60000)} minutes with no state change, so Radar parked it. Resume the stage to pick up exactly where it stopped.`,
        reference: null,
        errorCode: "STALE_RUN",
        tool: "reaper",
        createdAt: now,
      });

      try {
        await transitionRun(ctx, {
          missionId: run.missionId,
          targetStage: run.currentStage,
          targetStatus: "blocked",
          interruption: "stale_run",
          eventType: "run.reaped",
          safeSummary: `Run parked after ${Math.round(STALE_RUN_MS / 60000)} minutes without progress. Resume the stage to continue.`,
        });
        reaped += 1;
      } catch {
        // Already moved on (a late stage landed, or the user stopped it).
      }
    }

    return { scanned: active.length, reaped };
  },
});

/**
 * Recovery helper: parks every run stuck in `active` regardless of age, for
 * clearing an environment that predates the scheduled sweep. Bounded and
 * idempotent (a parked run is no longer `active`).
 */
export const reapAllActive = internalMutation({
  args: { maxAgeMs: v.optional(v.number()) },
  returns: v.object({ reaped: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - Math.max(0, args.maxAgeMs ?? 0);
    const active = await ctx.db
      .query("agentRuns")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(SWEEP_LIMIT);

    let reaped = 0;
    for (const run of active) {
      if (run.updatedAt > cutoff) continue;
      await ctx.db.insert("runSteps", {
        missionId: run.missionId,
        runId: run._id,
        stage: run.currentStage,
        label: "run.reaped",
        summary: `Parked by an operator sweep: the run held stage ${run.currentStage} without progress. Resume the stage to continue.`,
        reference: null,
        errorCode: "STALE_RUN",
        tool: "reaper",
        createdAt: Date.now(),
      });
      try {
        await transitionRun(ctx, {
          missionId: run.missionId,
          targetStage: run.currentStage,
          targetStatus: "blocked",
          interruption: "stale_run",
          eventType: "run.reaped",
          safeSummary: "Run parked by an operator sweep; resume the stage to continue.",
        });
        reaped += 1;
      } catch {
        // Nothing to do.
      }
    }
    return { reaped };
  },
});
