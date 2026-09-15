import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";

const mode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const provider = v.union(v.literal("openai"), v.literal("dashscope"));
const plan = v.object({ _id: v.id("missionPlans"), missionId: v.id("missions"), normalizedGoal: v.string(), mode, strategyNotes: v.optional(v.string()), mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), createdAt: v.number() });

export const getForMission = query({
  args: { missionId: v.id("missions") }, returns: v.union(plan, v.null()),
  handler: async (ctx, args) => await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first(),
});

export const save = internalMutation({
  args: { missionId: v.id("missions"), normalizedGoal: v.string(), mode, strategyNotes: v.optional(v.string()), mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), searchQueries: v.optional(v.array(v.string())), crawlTargets: v.optional(v.array(v.string())) },
  returns: v.id("missionPlans"),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    const value = { ...args, createdAt: Date.now() };
    delete (value as Record<string, unknown>).searchQueries;
    delete (value as Record<string, unknown>).crawlTargets;
    let planId: Id<"missionPlans">;
    if (existing) { await ctx.db.replace(existing._id, value); planId = existing._id; }
    else planId = await ctx.db.insert("missionPlans", value);

    // Materialize the planner's discovery backlog (replace any previous one).
    for (const old of await ctx.db.query("missionQueries").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect()) {
      await ctx.db.delete(old._id);
    }
    const seen = new Set<string>();
    const now = Date.now();
    for (const raw of [...(args.searchQueries ?? []).map((q) => q.trim()), ...(args.crawlTargets ?? []).map((q) => q.trim())]) {
      const query = raw.slice(0, 300);
      if (!query || seen.has(query)) continue;
      seen.add(query);
      const isCrawl = (args.crawlTargets ?? []).map((c) => c.trim()).includes(query);
      await ctx.db.insert("missionQueries", { missionId: args.missionId, query, kind: isCrawl ? "crawl" : "search", status: "pending", resultCount: null, createdAt: now });
    }
    return planId;
  },
});
