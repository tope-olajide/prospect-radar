import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { boundedText } from "./hash";
import { recordStep } from "./runs";
import { validateWorkspace } from "./model/auth";

const mode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const provider = v.union(v.literal("openai"), v.literal("dashscope"));
const successKind = v.union(v.literal("contact_and_wait"), v.literal("find_candidates"), v.literal("present_solution"));
/**
 * What "done" means, as the plan states it.
 *
 * `successKind` picks the shape of the finish line and `targetCount` its size,
 * so "find me 10 clinics" and "get one reply" are different objectives rather
 * than the same intent. Optional because plans written before objectives
 * existed have none, and the intent's default stands in for them.
 */
const objectiveFields = {
  successKind: v.optional(successKind),
  targetCount: v.optional(v.number()),
};

const plan = v.object({ _id: v.id("missionPlans"), missionId: v.id("missions"), normalizedGoal: v.string(), mode, strategyNotes: v.optional(v.string()), ...objectiveFields, userEditedAt: v.optional(v.number()), mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), createdAt: v.number() });

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
  args: { missionId: v.id("missions"), normalizedGoal: v.string(), mode, strategyNotes: v.optional(v.string()), ...objectiveFields, mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()), missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()), completionPredicate: v.string(), provider, model: v.string(), searchQueries: v.optional(v.array(v.string())), crawlTargets: v.optional(v.array(v.string())) },
  returns: v.id("missionPlans"),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    const value = { ...args, createdAt: Date.now() };
    delete (value as Record<string, unknown>).searchQueries;
    delete (value as Record<string, unknown>).crawlTargets;
    // The objective is the user's decision once they have stated it. Re-planning
    // rewrites the strategy beneath it, but not the finish line the user set —
    // otherwise a re-plan would silently move the goalposts on a running mission.
    if (existing?.userEditedAt && existing.successKind) {
      value.successKind = existing.successKind;
      value.targetCount = existing.targetCount ?? value.targetCount;
    }
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
/**
 * The plan's objective as the mission loop reads it.
 *
 * A tiny internal view on purpose: the decision and completion layers only need
 * the objective, and reading it through the plan keeps one source of truth for
 * what "done" means.
 */
export const objectiveFor = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.union(v.object({ successKind: v.union(successKind, v.null()), targetCount: v.union(v.number(), v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!row) return null;
    return { successKind: row.successKind ?? null, targetCount: row.targetCount ?? null };
  },
});

/**
 * Sets what "done" means for this mission.
 *
 * The planner proposes an objective from the user's request; this is how the
 * user corrects it — "actually, give me ten of them" or "I want a reply, not a
 * list". It is a user decision, so it is marked `userEditedAt`, and completion
 * and action selection both read it from here rather than from the intent label.
 */
export const setObjective = mutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    successKind,
    targetCount: v.number(),
  },
  returns: v.object({ planId: v.id("missionPlans"), successKind, targetCount: v.number() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const existing = await ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!existing) throw new Error("PLAN_MISSING: plan the mission before setting its objective.");
    // Bounded the same way the resolver bounds it, so what is stored is what
    // the loop will measure against.
    const targetCount = Math.max(1, Math.min(Math.floor(args.targetCount), 100));
    const now = Date.now();
    await ctx.db.patch(existing._id, { successKind: args.successKind, targetCount, userEditedAt: now });
    await recordStep(ctx, {
      missionId: args.missionId,
      stage: "approval",
      label: "objective.set",
      summary: `You set what finished means for this mission: ${args.successKind === "contact_and_wait" ? `contact ${targetCount} counterpart(s) and wait for a reply` : args.successKind === "present_solution" ? `present ${targetCount} credible solution(s)` : `assemble ${targetCount} qualified candidate(s)`}.`,
      reference: existing._id,
      errorCode: null,
      tool: "user",
    });
    // An objective that no longer needs contact releases a run parked on the
    // gate: there is nothing left to approve.
    try {
      await ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: args.missionId });
    } catch {
      // Advisory: the objective is saved regardless of whether it completes now.
    }
    return { planId: existing._id, successKind: args.successKind, targetCount };
  },
});

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
