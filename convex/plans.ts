import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

const mode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const provider = v.union(v.literal("openai"), v.literal("dashscope"));
const plan = v.object({ _id: v.id("missionPlans"), missionId: v.id("missions"), normalizedGoal: v.string(), mode, mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), createdAt: v.number() });

export const getForMission = query({
  args: { missionId: v.id("missions") }, returns: v.union(plan, v.null()),
  handler: async (ctx, args) => await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first(),
});

export const save = internalMutation({
  args: { missionId: v.id("missions"), normalizedGoal: v.string(), mode, mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string() },
  returns: v.id("missionPlans"),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    const value = { ...args, createdAt: Date.now() };
    if (existing) { await ctx.db.replace(existing._id, value); return existing._id; }
    return await ctx.db.insert("missionPlans", value);
  },
});
