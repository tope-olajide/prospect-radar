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
      providerMessageId: null,
      threadId: null,
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
    providerDraftId: v.union(v.string(), v.null()),
    providerMessageId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
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
      providerDraftId: draftRow.providerDraftId,
      providerMessageId: draftRow.providerMessageId,
      threadId: draftRow.threadId,
    };
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
