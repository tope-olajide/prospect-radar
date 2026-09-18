"use node";

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  ORCHESTRATOR_CRAWL_LIMIT,
  ORCHESTRATOR_EXTRACT_LIMIT,
  ORCHESTRATOR_SEARCH_LIMIT,
  estimateCrawl,
  estimateExtraction,
  estimateSearch,
} from "./budget";
import { BUDGET_BLOCKED_INTERRUPTION, classifyAndDecide } from "./retryPolicy";
import { classifyProviderError } from "./providerErrors";

/**
 * The mission orchestrator: the agent that drives a run through its stages.
 *
 * `runStage` executes exactly one stage and schedules the next via the Convex
 * scheduler, so long missions progress across many durable action invocations
 * instead of one long-running action. Every invocation re-reads the run state
 * first: a user Stop, a failure, or an external wait makes stale scheduled
 * stages no-op. Human gates are hard stops — the orchestrator never advances
 * past `approval` on its own.
 *
 * Everything else (public entry points `runPipeline`/`stopRun`/`retryStage`,
 * and all bookkeeping queries/mutations) lives in `orchestratorStore.ts`:
 * Convex allows only actions in "use node" modules, and this module needs the
 * Node runtime for crypto.randomUUID and fetch-based provider calls.
 */

/** Runs that may legally advance: active (working) or queued (not started). */
function advanceable(status: string, stage: string): boolean {
  return status === "active" || (status === "queued" && stage === "intake");
}

type Stage = "intake" | "interpret" | "plan" | "plan_review" | "discover" | "check_in" | "evaluate" | "approval" | "execute" | "wait" | "complete";

type RunRow = {
  _id: Id<"agentRuns">;
  status: string;
  currentStage: string;
  retryCount: number;
};

async function runForMission(ctx: ActionCtx, missionId: Id<"missions">): Promise<RunRow | null> {
  return await ctx.runQuery(internal.orchestratorStore.runRow, { missionId });
}

/**
 * The pre-flight credit gate. Called before a provider call the orchestrator is
 * about to make; on refusal the run parks in `blocked` with a distinct budget
 * interruption, keeping its stage so a retry resumes exactly here.
 *
 * This is a *budget block*, not a failure: the transcript records it with the
 * `FIRECRAWL_CREDITS_EXHAUSTED` code and the UI presents it as a spend decision.
 */
async function guardBudget(
  ctx: ActionCtx,
  args: { missionId: Id<"missions">; estimate: number; label: string },
): Promise<{ allowed: boolean }> {
  const mission = await ctx.runQuery(internal.missionsInternal.get, { missionId: args.missionId });
  if (!mission) return { allowed: true };
  const check = await ctx.runQuery(internal.budget.check, {
    workspaceId: mission.workspaceId,
    estimate: args.estimate,
  });
  if (check.allowed) return { allowed: true };

  const run = await runForMission(ctx, args.missionId);
  if (!run || ["cancelled", "complete"].includes(run.status)) return { allowed: false };
  const stage = run.currentStage as Stage;
  try {
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId,
      targetStage: stage,
      targetStatus: "blocked",
      interruption: BUDGET_BLOCKED_INTERRUPTION,
      eventType: "budget.blocked",
      safeSummary: `Budget blocked: ${args.label} needs about ${check.estimate} credits and ${check.remaining} remain.`,
    });
  } catch {
    // A concurrent state change won the race; the transcript step below still records why.
  }
  await ctx.runMutation(internal.runs.recordStepForAction, {
    missionId: args.missionId,
    stage,
    label: "budget.blocked",
    summary: `${args.label} is paused: it is estimated at ${check.estimate} credits, ${check.used} of ${check.creditLimit} are already used, and ${check.remaining} remain. Raise the cap or add provider credits, then retry the stage.`,
    reference: null,
    errorCode: "FIRECRAWL_CREDITS_EXHAUSTED",
    tool: "budget",
  });
  return { allowed: false };
}

/**
 * Marks a stage failure and returns whether the stage may retry.
 *
 * The retry decision and the backoff both come from `retryPolicy`, so the
 * classification a failure receives is the only thing that decides whether it
 * retries — a non-retryable code such as `FIRECRAWL_CREDITS_EXHAUSTED` or a
 * policy refusal never loops.
 */
async function failStage(ctx: ActionCtx, args: { missionId: Id<"missions">; stage: Stage; message: string }) {
  const run = await runForMission(ctx, args.missionId);
  if (!run || ["cancelled", "complete"].includes(run.status)) return { retry: false, delayMs: 0, classified: null, interruption: null };
  const { classified, retry, delayMs } = classifyAndDecide(args.message, run.retryCount ?? 0);
  // Block at the run's CURRENT stage: a stage handler may have already
  // advanced the run (e.g. intake → interpret) before the failure, and
  // transitionRun only permits legal edges. Research-level failures may also
  // have flipped the run to terminal "failed"; recover it to blocked at the
  // same stage so retry stays possible.
  const blockedStage = run.currentStage as Stage;
  if (["active", "queued", "waiting", "blocked", "failed"].includes(run.status)) {
    try {
      await ctx.runMutation(internal.runs.transition, {
        missionId: args.missionId,
        targetStage: blockedStage,
        targetStatus: "blocked",
        interruption: classified.code,
        eventType: `stage.${blockedStage}.failed`,
        safeSummary: `${args.stage} stage failed: ${args.message.slice(0, 200)}`,
      });
    } catch {
      // A concurrent state change won the race; nothing more to do here.
    }
  }
  await ctx.runMutation(internal.runs.recordStepForAction, {
    missionId: args.missionId,
    stage: blockedStage,
    label: `stage.${args.stage}.failed`,
    summary: args.message.slice(0, 400),
    reference: null,
    errorCode: classified.code,
    tool: "orchestrator",
  });
  if (retry) {
    await ctx.runMutation(internal.orchestratorStore.bumpRetry, { missionId: args.missionId });
  }
  return { retry, delayMs, classified, interruption: classified?.code ?? null };
}

export const runStage = internalAction({
  args: { missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const run = await runForMission(ctx, args.missionId);
    if (!run) return null;
    if (!advanceable(run.status, run.currentStage)) {
      return null; // stopped, blocked, waiting, finished — this invocation is stale
    }
    const stage = run.currentStage as Stage;

    try {
      switch (stage) {
        case "intake": {
          // Classify first; the classifier itself transitions the run to
          // interpret on success. Failing here blocks at intake so a retry
          // re-runs classification.
          const classification = await ctx.runAction(api.ai.classifyMissionIntent, { missionId: args.missionId });
          // If the classifier detected ambiguity it cannot resolve from profile
          // or sources, pause the run so the user can answer before planning.
          if (classification.clarificationNeeded && classification.clarificationQuestion) {
            await ctx.runMutation(internal.runs.transition, {
              missionId: args.missionId, targetStage: "intake", targetStatus: "waiting",
              interruption: null, eventType: "clarification.waiting",
              safeSummary: `Radar needs clarification: ${classification.clarificationQuestion}`,
            });
            return null;
          }
          await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
          return null;
        }
        case "interpret": {
          // Intent is persisted; produce the strategy-bearing plan. The plan
          // save materializes the discovery backlog (missionQueries).
          await ctx.runAction(api.ai.planMission, { missionId: args.missionId });
          await ctx.runMutation(internal.orchestratorStore.stageDone, {
            missionId: args.missionId, stage: "interpret", nextStage: "plan_review",
            eventType: "stage.plan_review.started", summary: "Plan ready — review it before Radar starts searching.",
          });
          // Pause for user review: transition to waiting so the orchestrator
          // stops. The user clicks Approve Plan which sets status back to active.
          await ctx.runMutation(internal.runs.transition, {
            missionId: args.missionId, targetStage: "plan_review", targetStatus: "waiting",
            interruption: null, eventType: "plan_review.waiting", safeSummary: "Radar is waiting for you to review the plan.",
          });
          return null;
        }
        case "discover": {
          const pending = await ctx.runQuery(internal.orchestratorStore.pendingQueries, { missionId: args.missionId });
          if (pending.length === 0) {
            await ctx.runMutation(internal.orchestratorStore.stageDone, {
              missionId: args.missionId, stage: "discover", nextStage: "check_in",
              eventType: "stage.check_in.started", summary: "Discovery finished — here's what Radar found.",
            });
            await ctx.runMutation(internal.runs.transition, {
              missionId: args.missionId, targetStage: "check_in", targetStatus: "waiting",
              interruption: null, eventType: "check_in.waiting", safeSummary: "Radar is showing you what it found before evaluating.",
            });
            return null;
          }
          const next = pending[0];
          if (next.kind === "crawl") {
            let parsed: URL;
            try {
              parsed = new URL(next.query);
            } catch {
              await ctx.runMutation(internal.orchestratorStore.skipQuery, { queryId: next._id, missionId: args.missionId, reason: "The planner produced an invalid crawl URL." });
              await ctx.scheduler.runAfter(2000, internal.missionOrchestrator.runStage, { missionId: args.missionId });
              return null;
            }
            const budget = await guardBudget(ctx, {
              missionId: args.missionId,
              estimate: estimateCrawl(ORCHESTRATOR_CRAWL_LIMIT),
              label: `the crawl of ${parsed.hostname}`,
            });
            if (!budget.allowed) return null;
            // Durable crawl: startCrawlJob keeps the run in discover, the
            // crawl runs asynchronously, and its completion callback
            // (crawlCompleted → completeCrawl) wakes the run.
            try {
              await ctx.runAction(api.research.startCrawl, {
                missionId: args.missionId, requestId: crypto.randomUUID(), url: parsed.toString(), limit: 25,
              });
            } catch (error) {
              // A host Firecrawl will not crawl (robots.txt, unsupported
              // scheme) is a missing source, not a dead mission: consume the
              // query with the classified reason and keep going down the
              // backlog. The job row and its step receipt were already written
              // by research.startCrawl's failure path.
              const message = error instanceof Error ? error.message : "Firecrawl crawl failed to start.";
              const classified = classifyProviderError(message);
              await ctx.runMutation(internal.orchestratorStore.failQuery, {
                queryId: next._id, missionId: args.missionId,
                reason: `${classified.summary} Radar skipped the crawl of ${parsed.hostname} and continued with the rest of the plan.`,
                errorCode: classified.code, tool: "firecrawl.crawl",
              });
              await ctx.scheduler.runAfter(2000, internal.missionOrchestrator.runStage, { missionId: args.missionId });
              return null;
            }
            await ctx.runMutation(internal.orchestratorStore.awaitCrawl, {
              queryId: next._id, missionId: args.missionId, host: parsed.hostname,
            });
            return null;
          }
          const budget = await guardBudget(ctx, {
            missionId: args.missionId,
            estimate: estimateSearch(ORCHESTRATOR_SEARCH_LIMIT),
            label: `the search "${next.query.slice(0, 80)}"`,
          });
          if (!budget.allowed) return null;
          let resultCount: number;
          try {
            const result = await ctx.runAction(api.research.search, {
              missionId: args.missionId, requestId: crypto.randomUUID(), query: next.query, limit: ORCHESTRATOR_SEARCH_LIMIT,
            });
            resultCount = result.resultCount;
          } catch (error) {
            // Same policy as a crawl: a failed search consumes its query with
            // the classified reason so the remaining backlog still runs.
            const message = error instanceof Error ? error.message : "Firecrawl search failed.";
            const classified = classifyProviderError(message);
            await ctx.runMutation(internal.orchestratorStore.failQuery, {
              queryId: next._id, missionId: args.missionId,
              reason: `${classified.summary} Radar skipped this discovery query and continued with the rest of the plan.`,
              errorCode: classified.code, tool: "firecrawl.search",
            });
            await ctx.scheduler.runAfter(2000, internal.missionOrchestrator.runStage, { missionId: args.missionId });
            return null;
          }
          await ctx.runMutation(internal.orchestratorStore.completeQuery, {
            queryId: next._id, missionId: args.missionId, resultCount,
          });
          await ctx.scheduler.runAfter(2000, internal.missionOrchestrator.runStage, { missionId: args.missionId });
          return null;
        }
        case "plan_review": {
          // Waiting for the user to approve the plan. The orchestrator
          // should not advance — the approvePlan mutation transitions to discover.
          return null;
        }
        case "check_in": {
          // Waiting for the user to review the discovery summary. The
          // continueAfterCheckIn mutation transitions to evaluate.
          return null;
        }
        case "evaluate": {
          // Job completion transitions may already have moved the run here
          // while discovery queries remain — loop back first.
          const pending = await ctx.runQuery(internal.orchestratorStore.pendingQueries, { missionId: args.missionId });
          if (pending.length > 0) {
            await ctx.runMutation(internal.runs.transition, {
              missionId: args.missionId, targetStage: "discover", targetStatus: "active",
              interruption: null, eventType: "stage.discover.resumed",
              safeSummary: `Resuming discovery: ${pending.length} quer${pending.length === 1 ? "y" : "ies"} remaining.`,
            });
            await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
            return null;
          }
          // Resolve scraped sources into entities + signals before explaining,
          // so matches are grounded in extracted attributes rather than
          // snippets. Extraction failures fall back per source and never block
          // the stage; a missing mission record does not stop evaluation either.
          const mission = await ctx.runQuery(internal.missionsInternal.get, { missionId: args.missionId });
          if (mission) {
            const budget = await guardBudget(ctx, {
              missionId: args.missionId,
              estimate: estimateExtraction(ORCHESTRATOR_EXTRACT_LIMIT),
              label: "resolving sources into entities",
            });
            let resolved = 0;
            if (budget.allowed) {
              try {
                const result = await ctx.runAction(api.research.resolveEntities, {
                  workspaceId: mission.workspaceId,
                  missionId: args.missionId,
                  limit: ORCHESTRATOR_EXTRACT_LIMIT,
                });
                resolved = result.resolved;
              } catch {
                // Fallback entities (or provider trouble) must not stop evaluation.
              }
            }
            // Extraction is bounded per invocation because each source can sit
            // at the provider for up to a minute, so the stage resolves one
            // batch and re-enters itself while scraped sources remain. Without
            // this, evaluation silently ignored sources discovery had already
            // paid to fetch — a live run explained matches off 6 of 19 sources.
            // Termination is structural: every resolved source gets an entity,
            // `unextractedSources` only returns sources that have none, so the
            // loop continues only while it is making progress.
            const remaining = await ctx.runQuery(internal.entityStore.unextractedSources, {
              missionId: args.missionId,
              limit: 1,
            });
            if (budget.allowed && resolved > 0 && remaining.length > 0) {
              await ctx.runMutation(internal.runs.recordStepForAction, {
                missionId: args.missionId,
                stage: "evaluate",
                label: "entity.extraction_continues",
                summary: `Resolved ${resolved} source${resolved === 1 ? "" : "s"} into entities; more scraped sources remain, so entity resolution continues before matches are explained.`,
                reference: null,
                errorCode: null,
                tool: "firecrawl.extract",
              });
              await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
              return null;
            }
            if (remaining.length > 0) {
              await ctx.runMutation(internal.runs.recordStepForAction, {
                missionId: args.missionId,
                stage: "evaluate",
                label: "entity.extraction_stopped",
                summary: `${remaining.length} scraped source${remaining.length === 1 ? "" : "s"} could not be resolved into entities (${budget.allowed ? "extraction made no progress" : "the mission budget is spent"}); matches are explained from the sources that resolved.`,
                reference: null,
                errorCode: null,
                tool: "firecrawl.extract",
              });
            }
          }
          await ctx.runAction(api.ai.explainMatches, { missionId: args.missionId });
          await ctx.runMutation(internal.orchestratorStore.stageDone, {
            missionId: args.missionId, stage: "evaluate", nextStage: "approval",
            eventType: "stage.approval.started", summary: "Matches explained — review them and approve a draft before anything is sent.",
          });
          return null;
        }
        case "approval": {
          // Hard stop: open the gate, then wait for the human.
          await ctx.runMutation(internal.runs.transition, {
            missionId: args.missionId, targetStage: "approval", targetStatus: "waiting",
            interruption: null, eventType: "approval.awaiting", safeSummary: "Awaiting your approval: nothing is sent until you approve a draft.",
          });
          return null;
        }
        case "plan":
        case "wait":
        case "execute":
        case "complete": {
          return null; // planning happens inside interpret; these are never auto-driven
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stage failed.";
      const { retry, delayMs, interruption } = await failStage(ctx, { missionId: args.missionId, stage, message });
      if (retry) {
        // The run is parked as `blocked` (visible, resumable). The retry has to
        // re-open that block first: `blocked` is not advanceable, so scheduling
        // `runStage` directly would silently do nothing.
        await ctx.scheduler.runAfter(delayMs, internal.orchestratorStore.retryResume, {
          missionId: args.missionId,
          interruption,
        });
      }
      return null;
    }
  },
});
