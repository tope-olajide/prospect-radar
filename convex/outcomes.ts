import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { boundedText } from "./hash";

const outcomeStatus = v.union(v.literal("open"), v.literal("waiting"), v.literal("replied"), v.literal("positive"), v.literal("negative"), v.literal("closed"), v.literal("unknown"));
const matchId = v.union(v.id("matches"), v.null());
const actionId = v.union(v.id("actionDrafts"), v.null());
const timeline = v.array(v.object({ type: v.string(), summary: v.string(), createdAt: v.number(), reference: v.optional(v.union(v.string(), v.null())) }));

export const pipelineStage = v.union(
  v.literal("contacted"), v.literal("replied"), v.literal("engaged"),
  v.literal("meeting"), v.literal("proposal"), v.literal("won"),
  v.literal("lost"), v.literal("dormant"),
);
export type PipelineStage = "contacted" | "replied" | "engaged" | "meeting" | "proposal" | "won" | "lost" | "dormant";

/**
 * Resolves a pipeline stage for a row that may predate the pipeline schema.
 * Older outcomes carry only `status`, so map that forward rather than inventing
 * a stage the data cannot support.
 */
export function pipelineStageOf(row: { stage?: PipelineStage; status: string }): PipelineStage {
  if (row.stage) return row.stage;
  switch (row.status) {
    case "positive": return "won";
    case "negative": return "lost";
    case "closed": return "lost";
    case "replied": return "replied";
    case "waiting": case "open": return "contacted";
    default: return "contacted";
  }
}

type TimelineEntry = { type: string; summary: string; createdAt: number; reference?: string | null };

const outcomeView = v.object({
  _id: v.id("outcomes"),
  workspaceId: v.string(),
  missionId: v.id("missions"),
  matchId,
  actionId,
  counterpart: v.string(),
  status: outcomeStatus,
  stage: pipelineStage,
  latestEvidence: v.string(),
  linkedThreadId: v.union(v.string(), v.null()),
  nextAction: v.string(),
  nextStepAt: v.union(v.number(), v.null()),
  completionPredicate: v.string(),
  timeline,
  createdAt: v.number(),
  updatedAt: v.number(),
});

function appendTimeline(entries: TimelineEntry[], entry: TimelineEntry) {
  // Dedupe on the reference too, so a replayed webhook cannot duplicate a
  // record while two genuinely different actions still both appear.
  const alreadyRecorded = entries.some((item) =>
    item.type === entry.type
    && item.summary === entry.summary
    && (item.reference ?? null) === (entry.reference ?? null));
  if (alreadyRecorded) return entries;
  return [...entries, entry].slice(-40);
}

/**
 * Advances a relationship's pipeline stage and records why.
 *
 * Stages are ordered; this helper refuses to move backwards (except into
 * `dormant`, which a live relationship may legitimately enter). A repeated
 * event is a no-op, so webhook replays cannot inflate the history.
 */
export async function applyStage<Ctx extends MutationCtx>(
  ctx: Ctx,
  args: {
    outcomeId: Id<"outcomes">;
    /** Omit to record history without moving the stage. */
    stage?: PipelineStage;
    summary: string;
    eventType: string;
    nextAction?: string;
    latestEvidence?: string;
    nextStepAt?: number | null;
    reference?: string | null;
  },
) {
  const outcome = await ctx.db.get(args.outcomeId);
  if (!outcome) return null;
  const order: PipelineStage[] = ["contacted", "replied", "engaged", "meeting", "proposal", "won"];
  const current = pipelineStageOf(outcome);
  const currentIndex = order.indexOf(current);
  const targetIndex = args.stage ? order.indexOf(args.stage) : currentIndex;
  const regressive = !!args.stage && args.stage !== "dormant" && args.stage !== "lost" && targetIndex < currentIndex;
  const terminal = current === "won" || current === "lost";
  const nextStage: PipelineStage = terminal || regressive ? current : (args.stage ?? current);
  const now = Date.now();
  await ctx.db.patch(outcome._id, {
    stage: nextStage,
    latestEvidence: args.latestEvidence ?? outcome.latestEvidence,
    nextAction: args.nextAction ? boundedText(args.nextAction, 400) : outcome.nextAction,
    nextStepAt: args.nextStepAt === undefined ? outcome.nextStepAt ?? null : args.nextStepAt,
    timeline: appendTimeline(outcome.timeline, { type: args.eventType, summary: boundedText(args.summary, 400), createdAt: now, reference: args.reference ?? null }),
    updatedAt: now,
  });
  return { outcomeId: outcome._id, stage: nextStage };
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
  const byAction = await ctx.db.query("outcomes")
    .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
    .first();
  // One relationship per match: a follow-up step joins the existing row instead
  // of creating a second relationship with the same counterpart.
  const byMatch = byAction ?? (args.matchId
    ? await ctx.db.query("outcomes")
      .withIndex("by_matchId", (q) => q.eq("matchId", args.matchId))
      .first()
    : null);
  const existing = byAction ?? (byMatch && byMatch.workspaceId === args.workspaceId ? byMatch : null);
  const predicate = await missionPredicate(ctx, args.missionId);
  const entry = { type: "action.sent", summary: args.summary, createdAt: now, reference: args.actionId };
  if (existing) {
    await ctx.db.patch(existing._id, {
      linkedThreadId: args.threadId,
      latestEvidence: args.summary,
      status: existing.status === "open" ? "waiting" : existing.status,
      stage: pipelineStageOf(existing),
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
    stage: "contacted",
    latestEvidence: args.summary,
    linkedThreadId: args.threadId,
    nextAction: "Wait for a reply or review delivery activity.",
    nextStepAt: null,
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
  const entry = { type: "inbox.reply_received", summary, createdAt: now, reference: args.threadId };
  const predicate = await missionPredicate(ctx, args.missionId);
  if (existing) {
    const current = pipelineStageOf(existing);
    await ctx.db.patch(existing._id, {
      latestEvidence: summary,
      status: "replied",
      // Arriving mail advances a cold relationship to `replied`; it never drags
      // an already-engaged one backwards.
      stage: current === "contacted" ? "replied" : current,
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
    stage: "replied",
    latestEvidence: summary,
    linkedThreadId: args.threadId,
    nextAction: "Review the reply and approve a response if needed.",
    nextStepAt: null,
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
    stage: pipelineStageOf(existing),
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
    return rows.filter((row) => row.workspaceId === args.workspaceId).map((row) => ({
      _id: row._id,
      workspaceId: row.workspaceId,
      missionId: row.missionId,
      matchId: row.matchId,
      actionId: row.actionId,
      counterpart: row.counterpart,
      status: row.status,
      stage: pipelineStageOf(row),
      latestEvidence: row.latestEvidence,
      linkedThreadId: row.linkedThreadId,
      nextAction: row.nextAction,
      nextStepAt: row.nextStepAt ?? null,
      completionPredicate: row.completionPredicate,
      timeline: row.timeline,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});

export const getForMission = query({
  args: { workspaceId: v.string(), outcomeId: v.id("outcomes") },
  returns: v.union(outcomeView, v.null()),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.get(args.outcomeId);
    if (!outcome || outcome.workspaceId !== args.workspaceId) return null;
    return {
      _id: outcome._id,
      workspaceId: outcome.workspaceId,
      missionId: outcome.missionId,
      matchId: outcome.matchId,
      actionId: outcome.actionId,
      counterpart: outcome.counterpart,
      status: outcome.status,
      stage: pipelineStageOf(outcome),
      latestEvidence: outcome.latestEvidence,
      linkedThreadId: outcome.linkedThreadId,
      nextAction: outcome.nextAction,
      nextStepAt: outcome.nextStepAt ?? null,
      completionPredicate: outcome.completionPredicate,
      timeline: outcome.timeline,
      createdAt: outcome.createdAt,
      updatedAt: outcome.updatedAt,
    };
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
    const stage = args.status === "positive" ? "won" as const
      : args.status === "negative" || args.status === "closed" ? "lost" as const
      : pipelineStageOf(outcome);
    await ctx.db.patch(outcome._id, {
      status: args.status,
      stage,
      nextAction: args.nextAction.trim(),
      timeline: appendTimeline(outcome.timeline, { type: "outcome.updated", summary: `Outcome marked ${args.status}.`, createdAt: now }),
      updatedAt: now,
    });
    return outcome._id;
  },
});
