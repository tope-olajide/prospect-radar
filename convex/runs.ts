import { v } from "convex/values";
import { query } from "./_generated/server";

const runStatus = v.union(v.literal("queued"), v.literal("active"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("cancelled"));
const runStage = v.union(v.literal("intake"), v.literal("interpret"), v.literal("plan"), v.literal("discover"), v.literal("evaluate"), v.literal("approval"), v.literal("execute"), v.literal("wait"), v.literal("complete"));
const run = v.object({ _id: v.id("agentRuns"), status: runStatus, currentStage: runStage, checkpointVersion: v.number(), activeInterruption: v.union(v.string(), v.null()), nextWakeAt: v.union(v.number(), v.null()), retryCount: v.number(), startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()), createdAt: v.number(), updatedAt: v.number() });

export const forMission = query({
  args: { missionId: v.id("missions") }, returns: v.union(run, v.null()),
  handler: async (ctx, args) => await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first(),
});
