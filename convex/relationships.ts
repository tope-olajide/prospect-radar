import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { boundedText } from "./hash";
import { applyStage, pipelineStageOf, type PipelineStage } from "./outcomes";

const pipelineStage = v.union(
  v.literal("contacted"), v.literal("replied"), v.literal("engaged"),
  v.literal("meeting"), v.literal("proposal"), v.literal("won"),
  v.literal("lost"), v.literal("dormant"),
);
const followUpStatus = v.union(
  v.literal("scheduled"), v.literal("due"), v.literal("done"),
  v.literal("snoozed"), v.literal("cancelled"),
);
const followUpView = v.object({
  _id: v.id("followUps"),
  missionId: v.id("missions"),
  outcomeId: v.union(v.id("outcomes"), v.null()),
  matchId: v.union(v.id("matches"), v.null()),
  threadId: v.union(v.string(), v.null()),
  note: v.string(),
  dueAt: v.number(),
  status: followUpStatus,
  source: v.union(v.literal("user"), v.literal("agent")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const meetingView = v.object({
  _id: v.id("meetings"),
  missionId: v.id("missions"),
  outcomeId: v.union(v.id("outcomes"), v.null()),
  matchId: v.union(v.id("matches"), v.null()),
  counterpart: v.string(),
  scheduledAt: v.number(),
  notes: v.string(),
  createdBy: v.string(),
  createdAt: v.number(),
});

const sequenceStepView = v.object({
  index: v.number(),
  intent: v.string(),
  trigger: v.union(
    v.literal("initial"), v.literal("no_reply"), v.literal("followup_due"), v.literal("reply_classified"),
  ),
  status: v.union(v.literal("pending"), v.literal("draft_ready"), v.literal("sent"), v.literal("skipped")),
  draftId: v.union(v.id("actionDrafts"), v.null()),
  queuedAt: v.union(v.number(), v.null()),
});

const sequenceView = v.object({
  _id: v.id("outreachSequences"),
  missionId: v.id("missions"),
  matchId: v.id("matches"),
  agentmailInboxId: v.string(),
  steps: v.array(sequenceStepView),
  status: v.union(v.literal("active"), v.literal("complete"), v.literal("cancelled")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const dayMs = 24 * 60 * 60 * 1000;

/** Default cadence for a Radar-managed outreach sequence, in days. */
export const defaultFollowUpDays = 3;
export const defaultCloseDays = 8;

const labelToStage: Record<string, PipelineStage> = {
  interested: "engaged",
  needs_info: "engaged",
  referral: "engaged",
  not_now: "dormant",
  negative: "lost",
  unknown: "replied",
};

/**
 * Records an inbound reply on the relationship pipeline.
 *
 * Called after reply classification, so the stage reflects what the reply
 * actually meant rather than merely that mail arrived. A deferral schedules a
 * follow-up instead of letting the relationship go quiet.
 */
export const applyReplyStage = internalMutation({
  args: {
    workspaceId: v.string(),
    threadId: v.string(),
    label: v.string(),
    summary: v.string(),
    followUpDays: v.optional(v.number()),
  },
  returns: v.union(v.object({ outcomeId: v.id("outcomes"), stage: pipelineStage }), v.null()),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.query("outcomes")
      .withIndex("by_linkedThreadId", (q) => q.eq("linkedThreadId", args.threadId))
      .first();
    if (!outcome || outcome.workspaceId !== args.workspaceId) return null;
    const stage = labelToStage[args.label] ?? "replied";
    const nextAction = stage === "engaged" ? "Reply with the next step and keep the conversation moving."
      : stage === "dormant" ? "Follow up when the timing they named arrives."
      : stage === "lost" ? "No further outreach unless the user asks for it."
      : "Review the reply and decide the next step.";
    const days = args.followUpDays ?? defaultFollowUpDays;
    const nextStepAt = stage === "dormant" ? Date.now() + days * dayMs : null;
    const result = await applyStage(ctx, {
      outcomeId: outcome._id,
      stage,
      summary: args.summary,
      eventType: "relationship.stage",
      nextAction,
      latestEvidence: args.summary,
      nextStepAt,
      reference: args.threadId,
    });
    if (stage === "dormant") {
      await ctx.db.insert("followUps", {
        workspaceId: args.workspaceId,
        missionId: outcome.missionId,
        outcomeId: outcome._id,
        matchId: outcome.matchId,
        threadId: args.threadId,
        note: "Re-open the conversation at the timing they suggested.",
        dueAt: nextStepAt ?? Date.now() + days * dayMs,
        status: "scheduled",
        source: "agent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return result ? { outcomeId: result.outcomeId, stage: result.stage } : null;
  },
});

export const scheduleFollowUp = mutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    outcomeId: v.union(v.id("outcomes"), v.null()),
    matchId: v.union(v.id("matches"), v.null()),
    threadId: v.union(v.string(), v.null()),
    note: v.string(),
    dueAt: v.number(),
    source: v.optional(v.union(v.literal("user"), v.literal("agent"))),
  },
  returns: v.id("followUps"),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    if (!args.note.trim() || args.note.length > 300) throw new Error("INVALID_ARGUMENT: follow-up note is invalid.");
    if (!Number.isFinite(args.dueAt)) throw new Error("INVALID_ARGUMENT: dueAt must be a timestamp.");
    if (args.outcomeId) {
      const outcome = await ctx.db.get(args.outcomeId);
      if (!outcome || outcome.workspaceId !== args.workspaceId) {
        throw new Error("FORBIDDEN_SCOPE: outcome is not in this workspace.");
      }
    }
    const now = Date.now();
    const followUpId = await ctx.db.insert("followUps", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      outcomeId: args.outcomeId,
      matchId: args.matchId,
      threadId: args.threadId,
      note: boundedText(args.note, 300),
      dueAt: args.dueAt,
      status: "scheduled",
      source: args.source ?? "user",
      createdAt: now,
      updatedAt: now,
    });
    if (args.outcomeId) {
      await applyStage(ctx, {
        outcomeId: args.outcomeId,
        summary: `Follow-up scheduled for ${new Date(args.dueAt).toISOString().slice(0, 10)}.`,
        eventType: "followup.scheduled",
        nextAction: boundedText(args.note, 400),
        nextStepAt: args.dueAt,
        reference: followUpId,
      });
    }
    return followUpId;
  },
});

export const snoozeFollowUp = mutation({
  args: { workspaceId: v.string(), followUpId: v.id("followUps"), dueAt: v.number() },
  returns: v.id("followUps"),
  handler: async (ctx, args) => {
    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp || followUp.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: follow-up is not in this workspace.");
    }
    if (!Number.isFinite(args.dueAt) || args.dueAt <= Date.now()) {
      throw new Error("INVALID_ARGUMENT: snooze time must be in the future.");
    }
    const now = Date.now();
    await ctx.db.patch(followUp._id, { status: "scheduled", dueAt: args.dueAt, updatedAt: now });
    if (followUp.outcomeId) {
      await applyStage(ctx, {
        outcomeId: followUp.outcomeId,
        summary: `Follow-up snoozed to ${new Date(args.dueAt).toISOString().slice(0, 10)}.`,
        eventType: "followup.snoozed",
        nextStepAt: args.dueAt,
        reference: followUp._id,
      });
    }
    return followUp._id;
  },
});

export const completeFollowUp = mutation({
  args: { workspaceId: v.string(), followUpId: v.id("followUps") },
  returns: v.id("followUps"),
  handler: async (ctx, args) => {
    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp || followUp.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: follow-up is not in this workspace.");
    }
    const now = Date.now();
    await ctx.db.patch(followUp._id, { status: "done", updatedAt: now });
    if (followUp.outcomeId) {
      await applyStage(ctx, {
        outcomeId: followUp.outcomeId,
        summary: "Follow-up marked done by the user.",
        eventType: "followup.done",
        nextStepAt: null,
        reference: followUp._id,
      });
    }
    return followUp._id;
  },
});

export const cancelFollowUp = mutation({
  args: { workspaceId: v.string(), followUpId: v.id("followUps") },
  returns: v.id("followUps"),
  handler: async (ctx, args) => {
    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp || followUp.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: follow-up is not in this workspace.");
    }
    await ctx.db.patch(followUp._id, { status: "cancelled", updatedAt: Date.now() });
    return followUp._id;
  },
});

export const recordMeeting = mutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    outcomeId: v.union(v.id("outcomes"), v.null()),
    matchId: v.union(v.id("matches"), v.null()),
    counterpart: v.string(),
    scheduledAt: v.number(),
    notes: v.string(),
  },
  returns: v.id("meetings"),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    if (!args.counterpart.trim()) throw new Error("INVALID_ARGUMENT: a meeting needs a counterpart.");
    if (!Number.isFinite(args.scheduledAt)) throw new Error("INVALID_ARGUMENT: scheduledAt must be a timestamp.");
    const meetingId = await ctx.db.insert("meetings", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      outcomeId: args.outcomeId,
      matchId: args.matchId,
      counterpart: boundedText(args.counterpart, 200),
      scheduledAt: args.scheduledAt,
      notes: boundedText(args.notes, 1200),
      createdBy: "user",
      createdAt: Date.now(),
    });
    if (args.outcomeId) {
      await applyStage(ctx, {
        outcomeId: args.outcomeId,
        stage: "meeting",
        summary: `Meeting recorded with ${boundedText(args.counterpart, 120)} on ${new Date(args.scheduledAt).toISOString().slice(0, 10)}.`,
        eventType: "relationship.meeting",
        nextAction: "Capture notes and agree the next step after the meeting.",
        reference: meetingId,
      });
    }
    return meetingId;
  },
});

export const setStage = mutation({
  args: {
    workspaceId: v.string(),
    outcomeId: v.id("outcomes"),
    stage: pipelineStage,
    nextAction: v.string(),
  },
  returns: v.id("outcomes"),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.get(args.outcomeId);
    if (!outcome || outcome.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: outcome is not in this workspace.");
    }
    await applyStage(ctx, {
      outcomeId: outcome._id,
      stage: args.stage,
      summary: `Stage set to ${args.stage} by the user.`,
      eventType: "relationship.stage_set",
      nextAction: args.nextAction,
    });
    return outcome._id;
  },
});

export const followUpsForMission = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(followUpView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("followUps")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("asc")
      .take(100);
    return rows
      .filter((row) => row.workspaceId === args.workspaceId && !["done", "cancelled"].includes(row.status))
      .map(({ _creationTime, workspaceId: _w, ...row }) => row);
  },
});

export const meetingsForMission = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(meetingView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("meetings")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    return rows
      .filter((row) => row.workspaceId === args.workspaceId)
      .map(({ _creationTime, workspaceId: _w, ...row }) => row);
  },
});

export const sequencesForMission = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(sequenceView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("outreachSequences")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    return rows
      .filter((row) => row.workspaceId === args.workspaceId)
      .map(({ _creationTime, workspaceId: _w, ...row }) => row);
  },
});

/** Context for drafting one sequence step: the match, the intent, and prior steps. */
export const sequenceStepContext = internalQuery({
  args: { sequenceId: v.id("outreachSequences"), index: v.number() },
  returns: v.union(v.object({
    sequenceId: v.id("outreachSequences"),
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.id("matches"),
    agentmailInboxId: v.string(),
    intent: v.string(),
    trigger: v.string(),
    totalSteps: v.number(),
    /** Recipient carried forward from the step we already sent, if any. */
    recipient: v.union(v.string(), v.null()),
    priorSubject: v.union(v.string(), v.null()),
    priorMessageId: v.union(v.string(), v.null()),
    priorDraftIds: v.array(v.string()),
  }), v.null()),
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get(args.sequenceId);
    const step = sequence?.steps?.[args.index];
    if (!sequence || !step) return null;
    const priorDrafts = [];
    for (const entry of sequence.steps.slice(0, args.index)) {
      if (!entry.draftId) continue;
      const draft = await ctx.db.get(entry.draftId);
      if (draft) priorDrafts.push(draft);
    }
    const anchor = priorDrafts[priorDrafts.length - 1] ?? null;
    return {
      sequenceId: sequence._id,
      workspaceId: sequence.workspaceId,
      missionId: sequence.missionId,
      matchId: sequence.matchId,
      agentmailInboxId: sequence.agentmailInboxId,
      intent: step.intent,
      trigger: step.trigger,
      totalSteps: sequence.steps.length,
      recipient: anchor?.recipient ?? null,
      priorSubject: anchor?.subject ?? null,
      priorMessageId: anchor?.providerMessageId ?? null,
      priorDraftIds: priorDrafts.map((draft) => draft._id as string),
    };
  },
});

/** Context for choosing a relationship's next step after a reply is classified. */
export const replyContext = internalQuery({
  args: { messageId: v.id("inboxMessages") },
  returns: v.union(v.object({
    messageId: v.id("inboxMessages"),
    workspaceId: v.string(),
    missionId: v.union(v.id("missions"), v.null()),
    threadId: v.string(),
    sender: v.string(),
    subject: v.string(),
    preview: v.string(),
    providerMessageId: v.string(),
    agentmailInboxId: v.string(),
    label: v.string(),
    classificationSummary: v.string(),
    suggestedDraftId: v.union(v.id("actionDrafts"), v.null()),
    outcomeId: v.union(v.id("outcomes"), v.null()),
    matchId: v.union(v.id("matches"), v.null()),
    currentStage: v.union(pipelineStage, v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const classification = await ctx.db.query("replyClassifications")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first();
    const outcome = await ctx.db.query("outcomes")
      .withIndex("by_linkedThreadId", (q) => q.eq("linkedThreadId", message.threadId))
      .first();
    return {
      messageId: message._id,
      workspaceId: message.workspaceId,
      missionId: message.missionId,
      threadId: message.threadId,
      sender: message.sender,
      subject: message.subject,
      preview: message.preview,
      providerMessageId: message.messageId,
      agentmailInboxId: message.agentmailInboxId,
      label: classification?.label ?? "unknown",
      classificationSummary: classification?.summary ?? "No classification has been recorded yet.",
      suggestedDraftId: classification?.suggestedDraftId ?? null,
      outcomeId: outcome?._id ?? null,
      matchId: outcome?.matchId ?? null,
      currentStage: outcome ? pipelineStageOf(outcome) : null,
    };
  },
});

/**
 * Applies an LLM-chosen next step to the relationship pipeline.
 *
 * `followUpAt` is only honoured for a non-negative delay, so an eager model
 * cannot schedule follow-ups on relationships the user just closed.
 */
export const applyNextStep = internalMutation({
  args: {
    workspaceId: v.string(),
    outcomeId: v.id("outcomes"),
    stage: pipelineStage,
    nextAction: v.string(),
    followUpAt: v.union(v.number(), v.null()),
    summary: v.string(),
    threadId: v.union(v.string(), v.null()),
    suggestedNote: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.id("outcomes"),
  handler: async (ctx, args) => {
    const outcome = await ctx.db.get(args.outcomeId);
    if (!outcome || outcome.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: outcome is not in this workspace.");
    }
    const result = await applyStage(ctx, {
      outcomeId: outcome._id,
      stage: args.stage,
      summary: args.summary,
      eventType: "relationship.next_step",
      nextAction: args.nextAction,
      nextStepAt: args.followUpAt,
      reference: args.threadId,
    });
    if (args.followUpAt && args.followUpAt > Date.now()) {
      const open = await ctx.db.query("followUps")
        .withIndex("by_outcomeId", (q) => q.eq("outcomeId", outcome._id))
        .filter((q) => q.eq(q.field("status"), "scheduled"))
        .first();
      if (open) {
        await ctx.db.patch(open._id, { dueAt: args.followUpAt, updatedAt: Date.now() });
      } else {
        await ctx.db.insert("followUps", {
          workspaceId: args.workspaceId,
          missionId: outcome.missionId,
          outcomeId: outcome._id,
          matchId: outcome.matchId,
          threadId: args.threadId,
          note: boundedText(args.suggestedNote ?? args.nextAction, 300),
          dueAt: args.followUpAt,
          status: "scheduled",
          source: "agent",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    return result ? result.outcomeId : outcome._id;
  },
});

/**
 * Starts a Radar-managed outreach sequence for a match.
 *
 * Step 0 is the intro the user already approved and sent. The remaining steps
 * are drafted only when their trigger fires, and every step still needs its own
 * approval before it can send.
 */
export const ensureSequence = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.id("matches"),
    agentmailInboxId: v.string(),
    actionId: v.id("actionDrafts"),
  },
  returns: v.id("outreachSequences"),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("outreachSequences")
      .withIndex("by_matchId", (q) => q.eq("matchId", args.matchId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    const sequenceId = await ctx.db.insert("outreachSequences", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      matchId: args.matchId,
      agentmailInboxId: args.agentmailInboxId,
      steps: [
        { index: 0, intent: "Intro grounded in the collected evidence.", trigger: "initial", status: "sent", draftId: args.actionId, queuedAt: now },
        { index: 1, intent: "Value-add follow-up: share one concrete, specific reason this is worth a reply.", trigger: "no_reply", status: "pending", draftId: null, queuedAt: null },
        { index: 2, intent: "Gentle close: make it easy to say yes or no, and leave the door open.", trigger: "followup_due", status: "pending", draftId: null, queuedAt: null },
      ],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("followUps", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      outcomeId: null,
      matchId: args.matchId,
      threadId: null,
      note: "Follow up if there has been no reply.",
      dueAt: now + defaultFollowUpDays * dayMs,
      status: "scheduled",
      source: "agent",
      createdAt: now,
      updatedAt: now,
    });
    return sequenceId;
  },
});

export const markStepDraftReady = internalMutation({
  args: {
    sequenceId: v.id("outreachSequences"),
    index: v.number(),
    draftId: v.id("actionDrafts"),
  },
  returns: v.id("outreachSequences"),
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get(args.sequenceId);
    if (!sequence) throw new Error("Sequence not found.");
    const steps = sequence.steps.map((step) => step.index === args.index
      ? { ...step, status: "draft_ready" as const, draftId: args.draftId, queuedAt: step.queuedAt ?? Date.now() }
      : step);
    await ctx.db.patch(sequence._id, { steps, updatedAt: Date.now() });
    return sequence._id;
  },
});

/** Marks the sequence step whose draft actually sent, and completes the sequence at the end. */
export const markStepSent = internalMutation({
  args: { actionId: v.id("actionDrafts") },
  returns: v.union(v.id("outreachSequences"), v.null()),
  handler: async (ctx, args) => {
    const sequences = await ctx.db.query("outreachSequences")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(200);
    for (const sequence of sequences) {
      const match = sequence.steps.some((step) => step.draftId === args.actionId);
      if (!match) continue;
      const steps = sequence.steps.map((step) => step.draftId === args.actionId
        ? { ...step, status: "sent" as const }
        : step);
      const lastIndex = Math.max(...steps.map((step) => step.index));
      const complete = steps.every((step) => step.status === "sent" || step.status === "skipped");
      await ctx.db.patch(sequence._id, {
        steps,
        status: complete ? "complete" as const : "active" as const,
        updatedAt: Date.now(),
      });
      return sequence._id;
    }
    return null;
  },
});

