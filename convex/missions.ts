import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { intentLabelUnion, missionModeUnion, modeForIntent, targetEntityUnion } from "./intentStrategy";
import type { Id } from "./_generated/dataModel";
import { validateWorkspace } from "./model/auth";

const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));
const intentObject = v.object({
  primary: intentLabelUnion,
  secondary: v.union(intentLabelUnion, v.null()),
  confidence: v.number(),
  rationale: v.string(),
});
const summary = v.object({
  _id: v.id("missions"), title: v.string(), rawGoal: v.string(), mode: missionModeUnion,
  intent: v.optional(intentObject), targetEntity: v.optional(targetEntityUnion),
  relationshipGoal: v.optional(v.string()), clarification: v.optional(v.string()),
  status: missionStatus, constraints: v.array(v.string()), sourceScope: v.string(),
  completionPredicate: v.string(), createdAt: v.number(), updatedAt: v.number(),
});

export const list = query({
  args: { workspaceId: v.string() }, returns: v.array(summary),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db.query("missions").withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId)).order("desc").take(50);
    return rows.map(({ _id, title, rawGoal, mode, intent, targetEntity, relationshipGoal, clarification, status, constraints, sourceScope, completionPredicate, createdAt, updatedAt }) => ({ _id, title, rawGoal, mode, intent, targetEntity, relationshipGoal, clarification, status, constraints, sourceScope, completionPredicate, createdAt, updatedAt }));
  },
});

/**
 * The user submits natural language only: no mode, no category. `mode` starts
 * as a neutral placeholder and is overwritten by the AI classification via
 * applyIntent once the classifier runs.
 */
export const create = mutation({
  args: { workspaceId: v.string(), title: v.string(), rawGoal: v.string(), constraints: v.array(v.string()), sourceScope: v.string(), completionPredicate: v.string() },
  returns: v.object({ missionId: v.id("missions"), runId: v.id("agentRuns") }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    const missionId: Id<"missions"> = await ctx.db.insert("missions", {
      workspaceId: args.workspaceId,
      title: args.title,
      rawGoal: args.rawGoal,
      mode: "opportunity",
      status: "ready",
      constraints: args.constraints,
      sourceScope: args.sourceScope,
      completionPredicate: args.completionPredicate,
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("agentRuns", { missionId, workspaceId: args.workspaceId, status: "queued", currentStage: "intake", checkpointVersion: 1, activeInterruption: null, nextWakeAt: null, retryCount: 0, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now });
    await ctx.db.insert("runEvents", { missionId, runId, type: "mission.created", stage: "intake", safeSummary: "Mission created from natural language; awaiting AI intent classification.", createdAt: now });
    return { missionId, runId };
  },
});

/** AI-only: persists the classifier's structured understanding of the mission. */
export const applyIntent = internalMutation({
  args: {
    missionId: v.id("missions"),
    intent: intentObject,
    targetEntity: targetEntityUnion,
    relationshipGoal: v.string(),
    mode: missionModeUnion,
    clarification: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.missionId, {
      intent: args.intent,
      targetEntity: args.targetEntity,
      relationshipGoal: args.relationshipGoal,
      mode: args.mode,
      clarification: args.clarification ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * User corrections flow through here: revising the goal clears the AI's
 * understanding so classification must run again. The user edits language,
 * never labels.
 */
export const reviseGoal = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions"), rawGoal: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const rawGoal = args.rawGoal.trim();
    if (!rawGoal) throw new Error("INVALID_ARGUMENT: goal text is required.");
    await ctx.db.patch(args.missionId, {
      rawGoal,
      title: rawGoal.slice(0, 80),
      intent: undefined,
      targetEntity: undefined,
      relationshipGoal: undefined,
      clarification: undefined,
      updatedAt: Date.now(),
    });
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (run) {
      await ctx.db.insert("runEvents", { missionId: args.missionId, runId: run._id, type: "mission.goal_revised", stage: "intake", safeSummary: "User corrected the goal text; re-classification required.", createdAt: Date.now() });
    }
    return null;
  },
});
