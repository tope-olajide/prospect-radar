"use node";

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  ORCHESTRATOR_CRAWL_LIMIT,
  ORCHESTRATOR_SEARCH_LIMIT,
  estimateCrawl,
  estimateExtraction,
  estimateSearch,
} from "./budget";
import { BUDGET_BLOCKED_INTERRUPTION, classifyAndDecide } from "./retryPolicy";

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

type Stage = "intake" | "interpret" | "plan" | "discover" | "evaluate" | "approval" | "execute" | "wait" | "complete";

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
  if (!run || ["cancelled", "complete"].includes(run.status)) return { retry: false, delayMs: 0, classified: null };
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
  return { retry, delayMs, classified };
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
          await ctx.runAction(api.ai.classifyMissionIntent, { missionId: args.missionId });
          await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
          return null;
        }
        case "interpret": {
          // Intent is persisted; produce the strategy-bearing plan. The plan
          // save materializes the discovery backlog (missionQueries).
          await ctx.runAction(api.ai.planMission, { missionId: args.missionId });
          await ctx.runMutation(internal.orchestratorStore.stageDone, {
            missionId: args.missionId, stage: "interpret", nextStage: "discover",
            eventType: "stage.discover.started", summary: "Plan ready — starting discovery.",
          });
          return null;
        }
        case "discover": {
          const pending = await ctx.runQuery(internal.orchestratorStore.pendingQueries, { missionId: args.missionId });
          if (pending.length === 0) {
            await ctx.runMutation(internal.orchestratorStore.stageDone, {
              missionId: args.missionId, stage: "discover", nextStage: "evaluate",
              eventType: "stage.discover.done", summary: "Discovery finished — evaluating what was found.",
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
              await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
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
            await ctx.runAction(api.research.startCrawl, {
              missionId: args.missionId, requestId: crypto.randomUUID(), url: parsed.toString(), limit: 25,
            });
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
          const result = await ctx.runAction(api.research.search, {
            missionId: args.missionId, requestId: crypto.randomUUID(), query: next.query, limit: ORCHESTRATOR_SEARCH_LIMIT,
          });
          await ctx.runMutation(internal.orchestratorStore.completeQuery, {
            queryId: next._id, missionId: args.missionId, resultCount: result.resultCount,
          });
          await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
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
              estimate: estimateExtraction(1),
              label: "resolving sources into entities",
            });
            if (budget.allowed) {
              try {
                await ctx.runAction(api.research.resolveEntities, {
                  workspaceId: mission.workspaceId,
                  missionId: args.missionId,
                  limit: 6,
                });
              } catch {
                // Fallback entities (or provider trouble) must not stop evaluation.
              }
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
      const { retry, delayMs } = await failStage(ctx, { missionId: args.missionId, stage, message });
      if (retry) {
        await ctx.scheduler.runAfter(delayMs, internal.missionOrchestrator.runStage, { missionId: args.missionId });
      }
      return null;
    }
  },
});
