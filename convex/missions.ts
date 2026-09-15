import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const missionMode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));
const summary = v.object({ _id: v.id("missions"), title: v.string(), rawGoal: v.string(), mode: missionMode, status: missionStatus, constraints: v.array(v.string()), sourceScope: v.string(), completionPredicate: v.string(), createdAt: v.number(), updatedAt: v.number() });

export const list = query({
  args: { workspaceId: v.string() }, returns: v.array(summary),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("missions").withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId)).order("desc").take(50);
    return rows.map(({ _id, title, rawGoal, mode, status, constraints, sourceScope, completionPredicate, createdAt, updatedAt }) => ({ _id, title, rawGoal, mode, status, constraints, sourceScope, completionPredicate, createdAt, updatedAt }));
  },
});

export const create = mutation({
  args: { workspaceId: v.string(), title: v.string(), rawGoal: v.string(), mode: missionMode, constraints: v.array(v.string()), sourceScope: v.string(), completionPredicate: v.string() },
  returns: v.object({ missionId: v.id("missions"), runId: v.id("agentRuns") }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const missionId = await ctx.db.insert("missions", { ...args, status: "ready", createdAt: now, updatedAt: now });
    const runId = await ctx.db.insert("agentRuns", { missionId, status: "queued", currentStage: "intake", checkpointVersion: 1, activeInterruption: null, nextWakeAt: null, retryCount: 0, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now });
    await ctx.db.insert("runEvents", { missionId, runId, type: "mission.created", stage: "intake", safeSummary: "Mission created and queued for structured interpretation.", createdAt: now });
    return { missionId, runId };
  },
});
