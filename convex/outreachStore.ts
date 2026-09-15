import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { contentHash, boundedText } from "./hash";
import { transitionRun } from "./runState";
import { recordOutboundOutcome } from "./outcomes";

const actionStatus = v.union(
  v.literal("draft"),
  v.literal("awaiting_approval"),
  v.literal("approved"),
  v.literal("executing"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("unverified"),
);
const approvalStatus = v.union(v.literal("active"), v.literal("used"), v.literal("expired"), v.literal("revoked"));

const approvalTtlMs = 60 * 60 * 1000;

export const draftView = v.object({
  _id: v.id("actionDrafts"),
  missionId: v.id("missions"),
  matchId: v.union(v.id("matches"), v.null()),
  agentmailInboxId: v.string(),
  recipient: v.string(),
  subject: v.string(),
  body: v.string(),
  contentHash: v.string(),
  status: actionStatus,
  outboundId: v.union(v.string(), v.null()),
  providerDraftId: v.union(v.string(), v.null()),
  providerMessageId: v.union(v.string(), v.null()),
  threadId: v.union(v.string(), v.null()),
  errorSummary: v.union(v.string(), v.null()),
  approvalStatus: v.union(approvalStatus, v.null()),
  approvalExpiresAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export const inboxForSend = internalQuery({
  args: { workspaceId: v.string(), agentmailInboxId: v.string() },
  returns: v.union(v.object({ _id: v.id("agentInboxes"), email: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.query("agentInboxes")
      .withIndex("by_agentmailInboxId", (q) => q.eq("agentmailInboxId", args.agentmailInboxId))
      .first();
    return inbox && inbox.workspaceId === args.workspaceId ? { _id: inbox._id, email: inbox.email } : null;
  },
});

export const inboxByClientRequestId = internalQuery({
  args: { workspaceId: v.string(), clientRequestId: v.string() },
  returns: v.union(v.object({
    _id: v.id("agentInboxes"),
    agentmailInboxId: v.string(),
    email: v.string(),
  }), v.null()),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.query("agentInboxes")
      .withIndex("by_workspaceId_and_clientRequestId", (q) => q.eq("workspaceId", args.workspaceId).eq("clientRequestId", args.clientRequestId))
      .first();
    return inbox ? { _id: inbox._id, agentmailInboxId: inbox.agentmailInboxId, email: inbox.email } : null;
  },
});

export const noteInboxClientRequest = internalMutation({
  args: { inboxId: v.id("agentInboxes"), clientRequestId: v.string() },
  returns: v.id("agentInboxes"),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.get(args.inboxId);
    if (!inbox) throw new Error("Inbox not found.");
    if (!inbox.clientRequestId) {
      await ctx.db.patch(inbox._id, { clientRequestId: args.clientRequestId });
    }
    return inbox._id;
  },
});

export const prepareDraft = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.union(v.id("matches"), v.null()),
    agentmailInboxId: v.string(),
    clientRequestId: v.string(),
    recipient: v.string(),
    subject: v.string(),
    body: v.string(),
    contentHash: v.string(),
    inReplyTo: v.optional(v.string()),
  },
  returns: v.object({
    actionId: v.id("actionDrafts"),
    status: actionStatus,
    providerDraftId: v.union(v.string(), v.null()),
    shouldCreate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const existing = await ctx.db.query("actionDrafts")
      .withIndex("by_clientRequestId", (q) => q.eq("clientRequestId", args.clientRequestId))
      .first();
    if (existing) {
      if (existing.contentHash !== args.contentHash || existing.recipient !== args.recipient) {
        throw new Error("IDEMPOTENCY_CONFLICT: clientRequestId is bound to different draft content.");
      }
      return {
        actionId: existing._id,
        status: existing.status,
        providerDraftId: existing.providerDraftId,
        shouldCreate: false,
      };
    }
    const duplicate = await ctx.db.query("actionDrafts")
      .withIndex("by_missionId_and_contentHash", (q) => q.eq("missionId", args.missionId).eq("contentHash", args.contentHash))
      .first();
    if (duplicate && ["approved", "executing", "sent", "delivered"].includes(duplicate.status)) {
      return { actionId: duplicate._id, status: duplicate.status, providerDraftId: duplicate.providerDraftId, shouldCreate: false };
    }
    const now = Date.now();
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId: args.missionId,
      matchId: args.matchId,
      workspaceId: args.workspaceId,
      agentmailInboxId: args.agentmailInboxId,
      clientRequestId: args.clientRequestId,
      providerDraftId: null,
      recipient: args.recipient,
      subject: args.subject,
      body: args.body,
      contentHash: args.contentHash,
      capability: "send_email",
      status: "draft",
      outboundId: null,
      providerMessageId: null,
      threadId: null,
      inReplyTo: args.inReplyTo,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    return { actionId, status: "draft" as const, providerDraftId: null, shouldCreate: true };
  },
});

export const attachProviderDraft = internalMutation({
  args: { actionId: v.id("actionDrafts"), providerDraftId: v.string() },
  returns: v.id("actionDrafts"),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionId, { providerDraftId: args.providerDraftId, updatedAt: Date.now() });
    return args.actionId;
  },
});

export const noteDraftError = internalMutation({
  args: { actionId: v.id("actionDrafts"), errorSummary: v.string() },
  returns: v.id("actionDrafts"),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionId, { errorSummary: boundedText(args.errorSummary, 240), updatedAt: Date.now() });
    return args.actionId;
  },
});

export const approve = mutation({
  args: { workspaceId: v.string(), actionId: v.id("actionDrafts") },
  returns: v.object({ actionId: v.id("actionDrafts"), status: actionStatus, expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow || draftRow.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: draft is not in this workspace.");
    }
    if (["sent", "delivered", "executing"].includes(draftRow.status)) {
      throw new Error("APPROVAL_REQUIRED: this draft was already sent.");
    }
    const hash = await contentHash(draftRow.recipient, draftRow.subject, draftRow.body);
    if (hash !== draftRow.contentHash) {
      throw new Error("APPROVAL_STALE: stored content hash mismatch; recreate the draft.");
    }
    const now = Date.now();
    const expiresAt = now + approvalTtlMs;
    const existing = await ctx.db.query("approvals")
      .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
      .first();
    if (existing && existing.status === "active" && existing.contentHash === hash && existing.expiresAt > now) {
      return { actionId: draftRow._id, status: draftRow.status, expiresAt: existing.expiresAt };
    }
    if (existing) {
      await ctx.db.patch(existing._id, { contentHash: hash, status: "active", expiresAt, resolvedAt: null });
    } else {
      await ctx.db.insert("approvals", {
        actionId: args.actionId,
        capability: "send_email",
        recipient: draftRow.recipient,
        contentHash: hash,
        approvedBy: args.workspaceId,
        status: "active",
        expiresAt,
        createdAt: now,
        resolvedAt: null,
      });
    }
    await ctx.db.patch(draftRow._id, { status: "approved", errorSummary: null, updatedAt: now });
    const run = await ctx.db.query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", draftRow.missionId))
      .first();
    if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
      try {
        await transitionRun(ctx, {
          missionId: draftRow.missionId,
          targetStage: "approval",
          targetStatus: "active",
          interruption: null,
          eventType: "action.approved",
          safeSummary: "User approved the exact recipient, subject, and body.",
        });
      } catch {
        // Stage transitions are advisory here; approval is the source of truth.
      }
    }
    return { actionId: draftRow._id, status: "approved" as const, expiresAt };
  },
});

export const draftForSend = internalQuery({
  args: { actionId: v.id("actionDrafts") },
  returns: v.union(v.object({
    _id: v.id("actionDrafts"),
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.union(v.id("matches"), v.null()),
    agentmailInboxId: v.string(),
    recipient: v.string(),
    subject: v.string(),
    body: v.string(),
    contentHash: v.string(),
    status: actionStatus,
    outboundId: v.union(v.string(), v.null()),
    providerDraftId: v.union(v.string(), v.null()),
    providerMessageId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
    inReplyTo: v.union(v.string(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow) return null;
    return {
      _id: draftRow._id,
      workspaceId: draftRow.workspaceId,
      missionId: draftRow.missionId,
      matchId: draftRow.matchId,
      agentmailInboxId: draftRow.agentmailInboxId,
      recipient: draftRow.recipient,
      subject: draftRow.subject,
      body: draftRow.body,
      contentHash: draftRow.contentHash,
      status: draftRow.status,
      outboundId: draftRow.outboundId ?? null,
      providerDraftId: draftRow.providerDraftId,
      providerMessageId: draftRow.providerMessageId,
      threadId: draftRow.threadId,
      inReplyTo: draftRow.inReplyTo ?? null,
    };
  },
});

export const markEnqueued = internalMutation({
  args: { actionId: v.id("actionDrafts"), outboundId: v.string() },
  returns: v.id("actionDrafts"),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow) throw new Error("Draft not found.");
    await ctx.db.patch(args.actionId, { outboundId: args.outboundId, updatedAt: Date.now() });
    return args.actionId;
  },
});

export const markExecuting = internalMutation({
  args: { actionId: v.id("actionDrafts") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow) throw new Error("Draft not found.");
    if (["executing", "sent", "delivered"].includes(draftRow.status)) return false;
    await ctx.db.patch(args.actionId, { status: "executing", errorSummary: null, updatedAt: Date.now() });
    return true;
  },
});

export const markSent = internalMutation({
  args: {
    actionId: v.id("actionDrafts"),
    providerMessageId: v.string(),
    threadId: v.string(),
  },
  returns: v.id("actionDrafts"),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow) throw new Error("Draft not found.");
    const now = Date.now();
    await ctx.db.patch(args.actionId, {
      status: "sent",
      providerMessageId: args.providerMessageId,
      threadId: args.threadId,
      errorSummary: null,
      updatedAt: now,
    });
    const approval = await ctx.db.query("approvals")
      .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
      .first();
    if (approval && approval.status === "active") {
      await ctx.db.patch(approval._id, { status: "used", resolvedAt: now });
    }
    await recordOutboundOutcome(ctx, {
      workspaceId: draftRow.workspaceId,
      missionId: draftRow.missionId,
      matchId: draftRow.matchId,
      actionId: draftRow._id,
      counterpart: draftRow.recipient,
      threadId: args.threadId,
      summary: "Approved message sent through AgentMail; awaiting delivery confirmation.",
    });
    const run = await ctx.db.query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", draftRow.missionId))
      .first();
    if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
      try {
        await transitionRun(ctx, {
          missionId: draftRow.missionId,
          targetStage: "wait",
          targetStatus: "waiting",
          interruption: "Waiting for delivery confirmation or an inbound reply.",
          eventType: "action.sent",
          safeSummary: "Approved message sent through AgentMail.",
        });
      } catch {
        // Waiting transition is advisory; send state is persisted regardless.
      }
    }
    return draftRow._id;
  },
});

export const markSendFailed = internalMutation({
  args: { actionId: v.id("actionDrafts"), errorSummary: v.string(), unverified: v.boolean() },
  returns: v.id("actionDrafts"),
  handler: async (ctx, args) => {
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow) throw new Error("Draft not found.");
    await ctx.db.patch(args.actionId, {
      status: args.unverified ? "unverified" : "failed",
      errorSummary: boundedText(args.errorSummary, 240),
      updatedAt: Date.now(),
    });
    return draftRow._id;
  },
});

export const activeApprovalFor = internalQuery({
  args: { actionId: v.id("actionDrafts") },
  returns: v.union(v.object({
    contentHash: v.string(),
    status: approvalStatus,
    expiresAt: v.number(),
  }), v.null()),
  handler: async (ctx, args) => {
    const approval = await ctx.db.query("approvals")
      .withIndex("by_actionId", (q) => q.eq("actionId", args.actionId))
      .first();
    if (!approval) return null;
    return { contentHash: approval.contentHash, status: approval.status, expiresAt: approval.expiresAt };
  },
});

export const listDrafts = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(draftView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("actionDrafts")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    const result = [];
    for (const row of rows) {
      const approval = await ctx.db.query("approvals")
        .withIndex("by_actionId", (q) => q.eq("actionId", row._id))
        .first();
      result.push({
        _id: row._id,
        missionId: row.missionId,
        matchId: row.matchId,
        agentmailInboxId: row.agentmailInboxId,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
        contentHash: row.contentHash,
        status: row.status,
        outboundId: row.outboundId ?? null,
        providerDraftId: row.providerDraftId,
        providerMessageId: row.providerMessageId,
        threadId: row.threadId,
        errorSummary: row.errorSummary,
        approvalStatus: approval ? approval.status : null,
        approvalExpiresAt: approval ? approval.expiresAt : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return result;
  },
});

export const linkInbox = mutation({
  args: {
    workspaceId: v.string(),
    agentmailInboxId: v.string(),
    email: v.string(),
    displayName: v.union(v.string(), v.null()),
  },
  returns: v.id("agentInboxes"),
  handler: async (ctx, args) => {
    const inboxId = args.agentmailInboxId.trim();
    const email = args.email.trim().toLowerCase();
    if (!inboxId || inboxId.length > 160) throw new Error("INVALID_ARGUMENT: inbox id is invalid.");
    if (!validEmail(email)) throw new Error("INVALID_ARGUMENT: inbox email is invalid.");
    const existing = await ctx.db.query("agentInboxes")
      .withIndex("by_agentmailInboxId", (q) => q.eq("agentmailInboxId", inboxId))
      .first();
    const now = Date.now();
    if (existing) {
      if (existing.workspaceId !== args.workspaceId) {
        throw new Error("IDEMPOTENCY_CONFLICT: inbox is already linked to another workspace.");
      }
      await ctx.db.patch(existing._id, { email, displayName: args.displayName, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("agentInboxes", {
      workspaceId: args.workspaceId,
      agentmailInboxId: inboxId,
      email,
      displayName: args.displayName,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getInbox = query({
  args: { workspaceId: v.string() },
  returns: v.union(v.object({
    _id: v.id("agentInboxes"),
    agentmailInboxId: v.string(),
    email: v.string(),
    displayName: v.union(v.string(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.query("agentInboxes")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();
    return inbox
      ? { _id: inbox._id, agentmailInboxId: inbox.agentmailInboxId, email: inbox.email, displayName: inbox.displayName }
      : null;
  },
});

const labelUnion = v.union(v.literal("interested"), v.literal("needs_info"), v.literal("not_now"), v.literal("referral"), v.literal("negative"), v.literal("unknown"));
const providerUnion = v.union(v.literal("openai"), v.literal("dashscope"));

export const markMessageClassifying = internalMutation({
  args: { messageId: v.id("inboxMessages") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return false;
    const existing = await ctx.db.query("replyClassifications")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first();
    if (existing) return false;
    await ctx.db.insert("replyClassifications", {
      messageId: args.messageId,
      missionId: message.missionId,
      threadId: message.threadId,
      label: "unknown",
      confidence: 0,
      summary: "Classification in progress.",
      suggestedNextAction: "Wait for classification to finish.",
      suggestedDraftId: null,
      provider: "openai",
      model: "pending",
      createdAt: Date.now(),
    });
    return true;
  },
});

export const draftForReply = internalQuery({
  args: { messageId: v.id("inboxMessages") },
  returns: v.union(v.object({
    _id: v.id("inboxMessages"),
    workspaceId: v.string(),
    missionId: v.union(v.id("missions"), v.null()),
    matchId: v.union(v.id("matches"), v.null()),
    agentmailInboxId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    sender: v.string(),
    subject: v.string(),
    preview: v.string(),
  }), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    return message ? {
      _id: message._id,
      workspaceId: message.workspaceId,
      missionId: message.missionId,
      matchId: null,
      agentmailInboxId: message.agentmailInboxId,
      threadId: message.threadId,
      messageId: message.messageId,
      sender: message.sender,
      subject: message.subject,
      preview: message.preview,
    } : null;
  },
});

export const saveClassification = internalMutation({
  args: {
    messageId: v.id("inboxMessages"),
    label: labelUnion,
    confidence: v.number(),
    summary: v.string(),
    suggestedNextAction: v.string(),
    suggestedDraftId: v.union(v.id("actionDrafts"), v.null()),
    provider: providerUnion,
    model: v.string(),
  },
  returns: v.id("replyClassifications"),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Inbox message not found.");
    const existing = await ctx.db.query("replyClassifications")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first();
    const value = {
      messageId: args.messageId,
      missionId: message.missionId,
      threadId: message.threadId,
      label: args.label,
      confidence: Math.max(0, Math.min(1, args.confidence)),
      summary: boundedText(args.summary, 600),
      suggestedNextAction: boundedText(args.suggestedNextAction, 300),
      suggestedDraftId: args.suggestedDraftId,
      provider: args.provider,
      model: args.model,
      createdAt: Date.now(),
    };
    if (existing) {
      await ctx.db.replace(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("replyClassifications", value);
  },
});

export const saveSuggestedDraftId = internalMutation({
  args: { classificationId: v.id("replyClassifications"), suggestedDraftId: v.id("actionDrafts") },
  returns: v.id("replyClassifications"),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.classificationId, { suggestedDraftId: args.suggestedDraftId });
    return args.classificationId;
  },
});

export const classificationForMessage = internalQuery({
  args: { messageId: v.id("inboxMessages") },
  returns: v.union(v.object({
    _id: v.id("replyClassifications"),
    label: labelUnion,
    summary: v.string(),
    suggestedNextAction: v.string(),
    suggestedDraftId: v.union(v.id("actionDrafts"), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const classification = await ctx.db.query("replyClassifications")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first();
    if (!classification || classification.model === "pending") return null;
    return {
      _id: classification._id,
      label: classification.label,
      summary: classification.summary,
      suggestedNextAction: classification.suggestedNextAction,
      suggestedDraftId: classification.suggestedDraftId,
    };
  },
});

export const messageProviderIdForReply = internalQuery({
  args: { messageId: v.id("inboxMessages") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    return message ? message.messageId : null;
  },
});

export const listClassifications = query({
  args: { workspaceId: v.string(), missionId: v.union(v.id("missions"), v.null()) },
  returns: v.array(v.object({
    _id: v.id("replyClassifications"),
    messageId: v.id("inboxMessages"),
    missionId: v.union(v.id("missions"), v.null()),
    threadId: v.string(),
    label: labelUnion,
    confidence: v.number(),
    summary: v.string(),
    suggestedNextAction: v.string(),
    suggestedDraftId: v.union(v.id("actionDrafts"), v.null()),
    provider: providerUnion,
    model: v.string(),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const rows = args.missionId
      ? await ctx.db.query("replyClassifications")
        .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
        .order("desc")
        .take(50)
      : await ctx.db.query("replyClassifications").order("desc").take(50);
    const result = [];
    for (const row of rows) {
      const message = await ctx.db.get(row.messageId);
      if (!message || message.workspaceId !== args.workspaceId) continue;
      result.push({
        _id: row._id,
        messageId: row.messageId,
        missionId: row.missionId,
        threadId: row.threadId,
        label: row.label,
        confidence: row.confidence,
        summary: row.summary,
        suggestedNextAction: row.suggestedNextAction,
        suggestedDraftId: row.suggestedDraftId,
        provider: row.provider,
        model: row.model,
        createdAt: row.createdAt,
      });
    }
    return result;
  },
});
