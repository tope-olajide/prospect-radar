import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { boundedText } from "./hash";
import { recordStep } from "./runs";
import { validateWorkspace } from "./model/auth";

const mode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const provider = v.union(v.literal("openai"), v.literal("dashscope"));
const plan = v.object({ _id: v.id("missionPlans"), missionId: v.id("missions"), normalizedGoal: v.string(), mode, strategyNotes: v.optional(v.string()), userEditedAt: v.optional(v.number()), mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), createdAt: v.number() });

export const getForMission = query({
  args: { missionId: v.id("missions") }, returns: v.union(plan, v.null()),
  handler: async (ctx, args) => {
    // Map explicitly: the raw document carries `_creationTime`, which the view
    // validator rejects (a live proof run caught this class of bug).
    const row = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!row) return null;
    const { _creationTime, ...view } = row;
    return view;
  },
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

/**
 * The brief is a living artifact: the user can correct the agent's plan. The
 * edits persist on the plan (marked `userEditedAt`) and the mission's
 * completion predicate stays in sync, because that predicate is what gates the
 * run's own completion claim.
 */
export const updateBrief = mutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    normalizedGoal: v.string(),
    mustHave: v.array(v.string()),
    niceToHave: v.array(v.string()),
    exclusions: v.array(v.string()),
    recommendedSources: v.array(v.string()),
    completionPredicate: v.string(),
  },
  returns: v.object({ planId: v.id("missionPlans"), completionPredicate: v.string() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const existing = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!existing) throw new Error("PLAN_MISSING: plan the mission before editing its brief.");
    const normalizedGoal = boundedText(args.normalizedGoal, 500);
    const completionPredicate = boundedText(args.completionPredicate, 300);
    if (!normalizedGoal) throw new Error("INVALID_ARGUMENT: the goal cannot be empty.");
    if (!completionPredicate) throw new Error("INVALID_ARGUMENT: the completion predicate cannot be empty.");
    const clean = (values: string[]) => values
      .map((value) => boundedText(value, 200))
      .filter((value) => value.length > 0)
      .slice(0, 12);
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      normalizedGoal,
      mustHave: clean(args.mustHave),
      niceToHave: clean(args.niceToHave),
      exclusions: clean(args.exclusions),
      recommendedSources: clean(args.recommendedSources),
      completionPredicate,
      userEditedAt: now,
    });
    await ctx.db.patch(mission._id, { completionPredicate, updatedAt: now });
    await recordStep(ctx, {
      missionId: args.missionId,
      stage: "interpret",
      label: "brief.edited",
      summary: "You edited the brief: goal, criteria, sources, and completion predicate now reflect your decision.",
      reference: existing._id,
      errorCode: null,
      tool: "user",
    });
    return { planId: existing._id, completionPredicate };
  },
});
