import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { intentLabelUnion, missionModeUnion, targetEntityUnion } from "./intentStrategy";

const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));

export const get = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.union(v.object({
    _id: v.id("missions"), workspaceId: v.string(), title: v.string(), rawGoal: v.string(), mode: missionModeUnion,
    intent: v.union(v.null(), v.object({
      primary: intentLabelUnion,
      secondary: v.union(intentLabelUnion, v.null()),
      confidence: v.number(),
      rationale: v.string(),
    })),
    targetEntity: v.union(v.null(), targetEntityUnion),
    relationshipGoal: v.union(v.null(), v.string()),
    clarification: v.union(v.null(), v.string()),
    status: missionStatus, sourceScope: v.string(), completionPredicate: v.string(),
  }), v.null()),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    return mission ? {
      _id: mission._id,
      workspaceId: mission.workspaceId,
      title: mission.title,
      rawGoal: mission.rawGoal,
      mode: mission.mode,
      intent: mission.intent ?? null,
      targetEntity: mission.targetEntity ?? null,
      relationshipGoal: mission.relationshipGoal ?? null,
      clarification: mission.clarification ?? null,
      status: mission.status,
      sourceScope: mission.sourceScope,
      completionPredicate: mission.completionPredicate,
    } : null;
  },
});
