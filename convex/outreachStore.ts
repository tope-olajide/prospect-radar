import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { contentHash, boundedText } from "./hash";
import { transitionRun } from "./runState";
import { recordOutboundOutcome } from "./outcomes";
import { validateWorkspace } from "./model/auth";
import { internal } from "./_generated/api";

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
  /**
   * The authorized documents this message carries, by title.
   *
   * Shown on the review card because the approval covers the whole action: the
   * user is approving the words *and* the attachments, so the attachments have
   * to be visible at the moment they approve.
   */
  attachments: v.array(v.object({ sourceId: v.id("dataSources"), title: v.string() })),
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
    /** Authorized artifacts attached to this message; covered by the hash. */
    artifactIds: v.optional(v.array(v.id("dataSources"))),
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
      artifactIds: args.artifactIds ?? [],
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
    await validateWorkspace(ctx, args.workspaceId);
    const draftRow = await ctx.db.get(args.actionId);
    if (!draftRow || draftRow.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: draft is not in this workspace.");
    }
    if (["sent", "delivered", "executing"].includes(draftRow.status)) {
      throw new Error("APPROVAL_REQUIRED: this draft was already sent.");
    }
    // Recomputed from the stored draft *including its attachments*, so the
    // approval the user gives is bound to the exact action they were shown.
    const hash = await contentHash(
      draftRow.recipient, draftRow.subject, draftRow.body, "send_email", draftRow.artifactIds ?? [],
    );
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
    // Approval is the gate the whole loop hangs on, so it resumes the mission.
    // This used to transition the run to `approval`/`active` without scheduling
    // anything, which left the agent looking busy at a stage it was not working
    // in; the page had to call `send` for the approved action to be executed at
    // all. `advanceToExecute` only moves a run that is parked on the gate.
    try {
      await ctx.runMutation(internal.orchestratorStore.advanceToExecute, { missionId: draftRow.missionId });
    } catch {
      // Advisory: approval is the source of truth even if the run cannot advance.
    }
    return { actionId: draftRow._id, status: "approved" as const, expiresAt };
  },
});

/**
 * Every draft on a mission that the user has approved but that has not left yet.
 *
 * Only `approved` is selected: an `executing` draft is already in flight, and
 * `send`'s own contract requires the approved status, so selecting it here would
 * only produce a guaranteed APPROVAL_REQUIRED failure.
 */
export const approvedDraftsForMission = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({ _id: v.id("actionDrafts"), recipient: v.string() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("actionDrafts")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();
    return rows
      .filter((row) => row.status === "approved")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({ _id: row._id, recipient: row.recipient }));
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
    /** The approved attachment set; the send path materializes it. */
    artifactIds: v.array(v.id("dataSources")),
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
      artifactIds: draftRow.artifactIds ?? [],
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

/**
 * The source record behind an approved attachment, read at send time.
 *
 * Returns `representationAllowed` so the send path can fail closed if the user
 * has since withdrawn authorization: an approval to send a document is not
 * permission to keep sending it after the permission is gone.
 */
export const artifactForSend = internalQuery({
  args: { sourceId: v.id("dataSources") },
  returns: v.union(v.object({
    sourceId: v.id("dataSources"),
    workspaceId: v.string(),
    title: v.string(),
    fileId: v.union(v.id("_storage"), v.null()),
    text: v.union(v.string(), v.null()),
    representationAllowed: v.boolean(),
  }), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceId);
    if (!row) return null;
    return {
      sourceId: row._id,
      workspaceId: row.workspaceId,
      title: row.title,
      fileId: row.fileId,
      text: row.text,
      representationAllowed: row.representationAllowed === true,
    };
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
    await validateWorkspace(ctx, args.workspaceId);
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
      const attachments = [];
      for (const sourceId of row.artifactIds ?? []) {
        const source = await ctx.db.get(sourceId);
        // A withdrawn authorization still shows, marked as such, rather than
        // vanishing from a card the user may have already approved.
        attachments.push({ sourceId, title: source?.title ?? "(removed document)" });
      }
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
        attachments,
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
    await validateWorkspace(ctx, args.workspaceId);
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
    await validateWorkspace(ctx, args.workspaceId);
    const inbox = await ctx.db.query("agentInboxes")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();
    return inbox
      ? { _id: inbox._id, agentmailInboxId: inbox.agentmailInboxId, email: inbox.email, displayName: inbox.displayName }
      : null;
  },
});

/**
 * The workspace's linked inbox, resolved without a client identity.
 *
 * `getInbox` is the user-facing read and asserts workspace authority from the
 * caller; the orchestrator has no caller identity, so it needs its own door.
 */
export const inboxForWorkspace = internalQuery({
  args: { workspaceId: v.string() },
  returns: v.union(v.object({ agentmailInboxId: v.string(), email: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const inbox = await ctx.db.query("agentInboxes")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();
    return inbox ? { agentmailInboxId: inbox.agentmailInboxId, email: inbox.email } : null;
  },
});

/**
 * Matches that already have a draft, so a proposal is never prepared twice.
 *
 * The approval gate can be re-entered (a rejected draft, a reply that needs a
 * new proposal), and `prepareDraft` is keyed on `clientRequestId` — but this
 * read is what keeps the agent from re-drafting the same counterpart at all.
 */
export const draftMatchIdsForMission = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.id("matches")),
  handler: async (ctx, args) => {
    const drafts = await ctx.db.query("actionDrafts")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();
    return drafts
      .map((draft) => draft.matchId)
      .filter((id): id is Id<"matches"> => id !== null);
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
    const classificationId = await ctx.db.insert("replyClassifications", value);
    await wakeRunOnReply(ctx, {
      missionId: message.missionId,
      label: args.label,
      nextAction: value.suggestedNextAction,
    });
    return classificationId;
  },
});

/**
 * Consume the wake stamped by an inbound reply: move a waiting run back to
 * active evaluation and log the classification for the user. Advisory only —
 * classification data is persisted regardless of run state.
 */
async function wakeRunOnReply(
  ctx: MutationCtx,
  args: { missionId: Id<"missions"> | null; label: string; nextAction: string },
) {
  if (!args.missionId) return;
  const missionId: Id<"missions"> = args.missionId;
  const run = await ctx.db.query("agentRuns")
    .withIndex("by_missionId", (q) => q.eq("missionId", missionId))
    .first();
  if (!run || ["complete", "failed", "cancelled"].includes(run.status)) return;
  const summary = `Reply classified as ${args.label}. Suggested next step: ${args.nextAction}`;
  if (run.status === "waiting" && run.currentStage === "wait") {
    try {
      await transitionRun(ctx, {
        missionId: args.missionId,
        targetStage: "evaluate",
        targetStatus: "active",
        interruption: null,
        eventType: "reply.classified",
        safeSummary: summary,
      });
      // Waking a parked run means more than moving it: the run had no
      // invocation in flight, so without this the reply would leave the
      // mission `active` at `evaluate` with nothing scheduled and the agent
      // would never read what the counterpart wrote. The webhook that woke it
      // has to hand the mission back to the orchestrator itself.
      await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId });
      return;
    } catch {
      // Fall through to the advisory event below.
    }
  }
  // Runs still mid-pipeline (or in a stage that cannot legally re-evaluate):
  // log the reply and clear the wake stamp so it is not left dangling.
  await ctx.db.patch(run._id, { nextWakeAt: null, updatedAt: Date.now() });
  await ctx.db.insert("runEvents", {
    missionId: args.missionId,
    runId: run._id,
    type: "reply.classified",
    stage: run.currentStage,
    safeSummary: summary,
    createdAt: Date.now(),
  });
}

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
    await validateWorkspace(ctx, args.workspaceId);
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
