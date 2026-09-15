import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { transitionRun } from "./runState";

const runStatus = v.union(v.literal("queued"), v.literal("active"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("cancelled"));
const runStage = v.union(v.literal("intake"), v.literal("interpret"), v.literal("plan"), v.literal("discover"), v.literal("evaluate"), v.literal("approval"), v.literal("execute"), v.literal("wait"), v.literal("complete"));
const run = v.object({ _id: v.id("agentRuns"), status: runStatus, currentStage: runStage, checkpointVersion: v.number(), activeInterruption: v.union(v.string(), v.null()), nextWakeAt: v.union(v.number(), v.null()), retryCount: v.number(), startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()), createdAt: v.number(), updatedAt: v.number() });
const event = v.object({ _id: v.id("runEvents"), missionId: v.id("missions"), runId: v.id("agentRuns"), type: v.string(), stage: runStage, safeSummary: v.string(), createdAt: v.number() });

export const forMission = query({
  args: { missionId: v.id("missions") }, returns: v.union(run, v.null()),
  handler: async (ctx, args) => await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first(),
});

export const events = query({
  args: { runId: v.id("agentRuns") }, returns: v.array(event),
  handler: async (ctx, args) => await ctx.db.query("runEvents").withIndex("by_runId", (q) => q.eq("runId", args.runId)).order("asc").take(100),
});

const stepView = v.object({
  _id: v.id("runSteps"),
  stage: runStage,
  label: v.string(),
  summary: v.string(),
  reference: v.union(v.string(), v.null()),
  errorCode: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

export const steps = query({
  args: { runId: v.id("agentRuns") }, returns: v.array(stepView),
  handler: async (ctx, args) =>
    await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", args.runId)).order("asc").take(100),
});

/**
 * Persist one structured run-step record (docs/data-api.md: AgentRun.steps).
 * Advisory: a recording failure must never fail the operation it describes.
 */
export async function recordStep(
  ctx: MutationCtx,
  args: {
    missionId: Id<"missions">;
    stage: "intake" | "interpret" | "plan" | "discover" | "evaluate" | "approval" | "execute" | "wait" | "complete";
    label: string;
    summary: string;
    reference?: string | null;
    errorCode?: string | null;
  },
) {
  try {
    const run = await ctx.db.query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .first();
    if (!run) return;
    await ctx.db.insert("runSteps", {
      missionId: args.missionId,
      runId: run._id,
      stage: args.stage,
      label: args.label.slice(0, 80),
      summary: args.summary.slice(0, 400),
      reference: args.reference ?? null,
      errorCode: args.errorCode ?? null,
      createdAt: Date.now(),
    });
  } catch {
    // Step records are advisory observability, never a gate.
  }
}

export const transition = internalMutation({
  args: {
    missionId: v.id("missions"), targetStage: runStage, targetStatus: runStatus,
    interruption: v.union(v.string(), v.null()), eventType: v.string(), safeSummary: v.string(),
  },
  returns: v.object({ runId: v.id("agentRuns"), status: runStatus, currentStage: runStage, changed: v.boolean() }),
  handler: async (ctx, args) => await transitionRun(ctx, args),
});
