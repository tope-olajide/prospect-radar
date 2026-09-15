import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

const missionMode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));

export const get = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.union(v.object({
    _id: v.id("missions"), workspaceId: v.string(), title: v.string(), rawGoal: v.string(), mode: missionMode,
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
      status: mission.status,
      sourceScope: mission.sourceScope,
      completionPredicate: mission.completionPredicate,
    } : null;
  },
});
