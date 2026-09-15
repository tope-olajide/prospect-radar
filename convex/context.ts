import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { boundedText } from "./hash";

const factStatus = v.union(v.literal("unreviewed"), v.literal("user_confirmed"), v.literal("user_corrected"), v.literal("user_rejected"));
const factVisibility = v.union(v.literal("mission"), v.literal("workspace"));
const factSource = v.union(v.literal("user_input"), v.literal("plan_extraction"), v.literal("source_extraction"), v.literal("agent_inference"));

const factView = v.object({
  _id: v.id("contextFacts"),
  workspaceId: v.string(),
  missionId: v.union(v.id("missions"), v.null()),
  category: v.string(),
  value: v.string(),
  sourceType: factSource,
  sourceReference: v.union(v.string(), v.null()),
  confidence: v.number(),
  verificationStatus: factStatus,
  visibility: factVisibility,
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const list = query({
  args: { workspaceId: v.string(), missionId: v.union(v.id("missions"), v.null()) },
  returns: v.array(factView),
  handler: async (ctx, args) => {
    const rows = args.missionId
      ? await ctx.db.query("contextFacts")
        .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
        .take(100)
      : await ctx.db.query("contextFacts")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .take(100);
    return rows
      .filter((row) => row.workspaceId === args.workspaceId)
      .map(({ _creationTime, ...row }) => row);
  },
});

export const add = mutation({
  args: {
    workspaceId: v.string(),
    missionId: v.union(v.id("missions"), v.null()),
    category: v.string(),
    value: v.string(),
    sourceType: factSource,
    sourceReference: v.union(v.string(), v.null()),
    confidence: v.number(),
    visibility: factVisibility,
  },
  returns: v.id("contextFacts"),
  handler: async (ctx, args) => {
    const category = boundedText(args.category, 60);
    const value = boundedText(args.value, 600);
    if (!category || !value) throw new Error("INVALID_ARGUMENT: fact category and value are required.");
    if (args.missionId) {
      const mission = await ctx.db.get(args.missionId);
      if (!mission || mission.workspaceId !== args.workspaceId) {
        throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
      }
    }
    const now = Date.now();
    return await ctx.db.insert("contextFacts", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      category,
      value,
      sourceType: args.sourceType,
      sourceReference: args.sourceReference,
      confidence: Math.max(0, Math.min(1, args.confidence)),
      // High-impact use requires explicit confirmation; anything the agent
      // inferred starts unreviewed and never auto-influences an approval.
      verificationStatus: args.sourceType === "user_input" ? "user_confirmed" : "unreviewed",
      visibility: args.visibility,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const confirm = mutation({
  args: { workspaceId: v.string(), factId: v.id("contextFacts") },
  returns: v.id("contextFacts"),
  handler: async (ctx, args) => {
    const fact = await ctx.db.get(args.factId);
    if (!fact || fact.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE: fact is not in this workspace.");
    await ctx.db.patch(fact._id, { verificationStatus: "user_confirmed", confidence: 1, updatedAt: Date.now() });
    return fact._id;
  },
});

export const correct = mutation({
  args: { workspaceId: v.string(), factId: v.id("contextFacts"), value: v.string() },
  returns: v.id("contextFacts"),
  handler: async (ctx, args) => {
    const fact = await ctx.db.get(args.factId);
    if (!fact || fact.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE: fact is not in this workspace.");
    const value = boundedText(args.value, 600);
    if (!value) throw new Error("INVALID_ARGUMENT: corrected value is required.");
    await ctx.db.patch(fact._id, { value, verificationStatus: "user_corrected", confidence: 1, updatedAt: Date.now() });
    return fact._id;
  },
});

export const reject = mutation({
  args: { workspaceId: v.string(), factId: v.id("contextFacts") },
  returns: v.id("contextFacts"),
  handler: async (ctx, args) => {
    const fact = await ctx.db.get(args.factId);
    if (!fact || fact.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE: fact is not in this workspace.");
    await ctx.db.patch(fact._id, { verificationStatus: "user_rejected", updatedAt: Date.now() });
    return fact._id;
  },
});

export const deleteFact = mutation({
  args: { workspaceId: v.string(), factId: v.id("contextFacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const fact = await ctx.db.get(args.factId);
    if (!fact || fact.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE: fact is not in this workspace.");
    await ctx.db.delete(fact._id);
    return null;
  },
});

/** Test seed path: insert a fact bypassing user confirmation defaults. */
export const seedForTest = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.union(v.id("missions"), v.null()),
    category: v.string(),
    value: v.string(),
    sourceType: factSource,
  },
  returns: v.id("contextFacts"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("contextFacts", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      category: boundedText(args.category, 60),
      value: boundedText(args.value, 600),
      sourceType: args.sourceType,
      sourceReference: null,
      confidence: 0.5,
      verificationStatus: "unreviewed",
      visibility: "workspace",
      createdAt: now,
      updatedAt: now,
    });
  },
});
