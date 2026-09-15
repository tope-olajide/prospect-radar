import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

const outcomeStatus = v.union(v.literal("open"), v.literal("waiting"), v.literal("replied"), v.literal("positive"), v.literal("negative"), v.literal("closed"), v.literal("unknown"));
const matchId = v.union(v.id("matches"), v.null());
const actionId = v.union(v.id("actionDrafts"), v.null());
const timeline = v.array(v.object({ type: v.string(), summary: v.string(), createdAt: v.number() }));

const outcomeView = v.object({
  _id: v.id("outcomes"),
  workspaceId: v.string(),
  missionId: v.id("missions"),
  matchId,
  actionId,
  counterpart: v.string(),
  status: outcomeStatus,
  latestEvidence: v.string(),
  linkedThreadId: v.union(v.string(), v.null()),
  nextAction: v.string(),
  completionPredicate: v.string(),
  timeline,
  createdAt: v.number(),
  updatedAt: v.number(),
});

function appendTimeline(
  entries: Array<{ type: string; summary: string; createdAt: number }>,
  entry: { type: string; summary: string; createdAt: number },
) {
  const alreadyRecorded = entries.some((item) => item.type === entry.type && item.summary === entry.summary);
  if (alreadyRecorded) return entries;
  return [...entries, entry].slice(-40);
}

async function missionPredicate(ctx: MutationCtx, missionId: Id<"missions">) {
  const mission = await ctx.db.get(missionId);
  return mission?.completionPredicate ?? "A user-reviewed, evidence-backed next action exists.";
}

export async function recordOutboundOutcome(
  ctx: MutationCtx,
  args: {
    workspaceId: string;
    missionId: Id<"missions">;
    matchId: Id<"matches"> | null;
    actionId: Id<"actionDrafts">;
    counterpart: string;
    threadId: string;
    summary: string;
  },
) {
  const now = Date.now();
  const existing = await ctx.db.query("outcomes")
    .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
    .first();
  const predicate = await missionPredicate(ctx, args.missionId);
  const entry = { type: "action.sent", summary: args.summary, createdAt: now };
  if (existing) {
    await ctx.db.patch(existing._id, {
      linkedThreadId: args.threadId,
      latestEvidence: args.summary,
      status: existing.status === "open" ? "waiting" : existing.status,
      nextAction: "Wait for a reply or review delivery activity.",
      timeline: appendTimeline(existing.timeline, entry),
      updatedAt: now,
    });
    return existing._id;
  }
  return await ctx.db.insert("outcomes", {
    workspaceId: args.workspaceId,
    missionId: args.missionId,
    matchId: args.matchId,
    actionId: args.actionId,
    counterpart: args.counterpart,
    status: "waiting",
    latestEvidence: args.summary,
    linkedThreadId: args.threadId,
    nextAction: "Wait for a reply or review delivery activity.",
    completionPredicate: predicate,
    timeline: [entry],
    createdAt: now,
    updatedAt: now,
  });
}

export async function recordReplyOutcome(
  ctx: MutationCtx,
  args: {
    workspaceId: string;
    missionId: Id<"missions">;
    matchId: Id<"matches"> | null;
    counterpart: string;
    threadId: string;
    preview: string;
  },
) {
  const now = Date.now();
  const existing = await ctx.db.query("outcomes")
    .withIndex("by_linkedThreadId", (q) => q.eq("linkedThreadId", args.threadId))
    .first();
  const summary = args.preview || "Inbound reply received; message body remains in AgentMail.";
  const entry = { type: "inbox.reply_received", summary, createdAt: now };
  const predicate = await missionPredicate(ctx, args.missionId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      latestEvidence: summary,
      status: "replied",
      nextAction: "Review the reply and approve a response if needed.",
      timeline: appendTimeline(existing.timeline, entry),
      updatedAt: now,
    });
    return existing._id;
  }
  return await ctx.db.insert("outcomes", {
    workspaceId: args.workspaceId,
    missionId: args.missionId,
    matchId: args.matchId,
    actionId: null,
    counterpart: args.counterpart,
    status: "replied",
    latestEvidence: summary,
    linkedThreadId: args.threadId,
    nextAction: "Review the reply and approve a response if needed.",
    completionPredicate: predicate,
    timeline: [entry],
    createdAt: now,
    updatedAt: now,
  });
}

export async function recordDeliveryOutcome(
  ctx: MutationCtx,
  args: {
    actionId: Id<"actionDrafts">;
    status: "delivered" | "failed" | "unknown";
    summary: string;
  },
) {
  const existing = await ctx.db.query("outcomes")
    .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
    .first();
  if (!existing) return null;
  const now = Date.now();
  const entry = { type: `action.${args.status}`, summary: args.summary, createdAt: now };
  await ctx.db.patch(existing._id, {
    status: args.status === "delivered" ? "waiting" : "unknown",
    latestEvidence: args.summary,
    nextAction: args.status === "delivered" ? "Wait for a reply or review the delivered thread." : "Review the delivery issue before retrying.",
    timeline: appendTimeline(existing.timeline, entry),
    updatedAt: now,
  });
  return existing._id;
}

export const listForMission = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(outcomeView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("outcomes")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    return rows.filter((row) => row.workspaceId === args.workspaceId).map(({ _creationTime, ...row }) => row);
  },
});

export const getForMission = query({
  args: { workspaceId: v.string(), outcomeId: v.id("outcomes") },
  returns: v.union(outcomeView, v.null()),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.get(args.outcomeId);
    return outcome && outcome.workspaceId === args.workspaceId ? (({ _creationTime, ...row }) => row)(outcome) : null;
  },
});

export const updateStatus = mutation({
  args: {
    workspaceId: v.string(),
    outcomeId: v.id("outcomes"),
    status: outcomeStatus,
    nextAction: v.string(),
  },
  returns: v.id("outcomes"),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.get(args.outcomeId);
    if (!outcome || outcome.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE: outcome is not in this workspace.");
    if (!args.nextAction.trim() || args.nextAction.length > 400) throw new Error("INVALID_ARGUMENT: next action is invalid.");
    const now = Date.now();
    await ctx.db.patch(outcome._id, {
      status: args.status,
      nextAction: args.nextAction.trim(),
      timeline: appendTimeline(outcome.timeline, { type: "outcome.updated", summary: `Outcome marked ${args.status}.`, createdAt: now }),
      updatedAt: now,
    });
    return outcome._id;
  },
});
