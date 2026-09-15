"use node";

import process from "node:process";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { contentHash, boundedText } from "./hash";

const actionStatus = v.union(v.literal("draft"), v.literal("awaiting_approval"), v.literal("approved"), v.literal("executing"), v.literal("sent"), v.literal("delivered"), v.literal("failed"), v.literal("cancelled"), v.literal("unverified"));
type ActionStatus = "draft" | "awaiting_approval" | "approved" | "executing" | "sent" | "delivered" | "failed" | "cancelled" | "unverified";

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function agentmailRequest(
  path: string,
  init: { method: string; body?: Record<string, unknown>; idempotencyKey?: string },
) {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not configured on this Convex deployment.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await fetch(`https://api.agentmail.to/v0/${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : "";
    if (response.status === 429) throw new Error("AgentMail rate limit reached. Retry later.");
    if (response.status === 403) throw new Error(`AgentMail rejected the message${message ? `: ${message}` : "."}`);
    throw new Error(`AgentMail request failed (${response.status}${code ? ` ${code}` : ""}).`);
  }
  return payload;
}

export const draft = action({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.union(v.id("matches"), v.null()),
    agentmailInboxId: v.string(),
    recipient: v.string(),
    subject: v.string(),
    body: v.string(),
    clientRequestId: v.string(),
  },
  returns: v.object({
    actionId: v.id("actionDrafts"),
    status: actionStatus,
    providerDraftId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<{ actionId: Id<"actionDrafts">; status: ActionStatus; providerDraftId: string | null }> => {
    const recipient = args.recipient.trim();
    const subject = boundedText(args.subject, 180);
    const body = args.body.trim().slice(0, 20000);
    if (!validEmail(recipient)) throw new Error("INVALID_ARGUMENT: recipient must be a valid email address.");
    if (!subject) throw new Error("INVALID_ARGUMENT: subject is required.");
    if (body.length < 20) throw new Error("INVALID_ARGUMENT: message body is too short to review.");
    if (!args.clientRequestId.trim() || args.clientRequestId.length > 160) {
      throw new Error("INVALID_ARGUMENT: clientRequestId is required.");
    }
    const inbox = await ctx.runQuery(internal.outreachStore.inboxForSend, {
      workspaceId: args.workspaceId,
      agentmailInboxId: args.agentmailInboxId,
    });
    if (!inbox) throw new Error("FORBIDDEN_SCOPE: inbox is not linked to this workspace.");

    const hash = await contentHash(recipient, subject, body);
    const prepared = await ctx.runMutation(internal.outreachStore.prepareDraft, {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      matchId: args.matchId,
      agentmailInboxId: args.agentmailInboxId,
      clientRequestId: args.clientRequestId,
      recipient,
      subject,
      body,
      contentHash: hash,
    });
    if (!prepared.shouldCreate) {
      return { actionId: prepared.actionId, status: prepared.status, providerDraftId: prepared.providerDraftId };
    }
    try {
      const payload = await agentmailRequest(`inboxes/${encodeURIComponent(args.agentmailInboxId)}/drafts`, {
        method: "POST",
        body: { to: [recipient], subject, text: body, client_id: args.clientRequestId },
      });
      const providerDraftId = typeof payload.draft_id === "string" ? payload.draft_id : null;
      if (providerDraftId) {
        await ctx.runMutation(internal.outreachStore.attachProviderDraft, {
          actionId: prepared.actionId,
          providerDraftId,
        });
      }
      return { actionId: prepared.actionId, status: prepared.status, providerDraftId };
    } catch (error) {
      await ctx.runMutation(internal.outreachStore.noteDraftError, {
        actionId: prepared.actionId,
        errorSummary: error instanceof Error ? error.message : "AgentMail draft creation failed.",
      });
      throw error;
    }
  },
});

export const send = action({
  args: { workspaceId: v.string(), actionId: v.id("actionDrafts") },
  returns: v.object({
    actionId: v.id("actionDrafts"),
    status: actionStatus,
    providerMessageId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<{ actionId: Id<"actionDrafts">; status: ActionStatus; providerMessageId: string | null; threadId: string | null }> => {
    const draftRow = await ctx.runQuery(internal.outreachStore.draftForSend, { actionId: args.actionId });
    if (!draftRow || draftRow.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: draft is not in this workspace.");
    }
    if (draftRow.providerMessageId && draftRow.threadId) {
      return {
        actionId: draftRow._id,
        status: draftRow.status,
        providerMessageId: draftRow.providerMessageId,
        threadId: draftRow.threadId,
      };
    }
    if (draftRow.status !== "approved") {
      throw new Error("APPROVAL_REQUIRED: approve the exact draft content before sending.");
    }
    const approval = await ctx.runQuery(internal.outreachStore.activeApprovalFor, { actionId: args.actionId });
    if (!approval) throw new Error("APPROVAL_REQUIRED: no active approval exists for this draft.");
    if (approval.contentHash !== draftRow.contentHash) {
      throw new Error("APPROVAL_STALE: draft changed after approval; approve again.");
    }
    if (approval.expiresAt <= Date.now()) throw new Error("APPROVAL_STALE: approval expired; approve again.");

    const started = await ctx.runMutation(internal.outreachStore.markExecuting, { actionId: draftRow._id });
    if (!started) {
      return { actionId: draftRow._id, status: "executing" as const, providerMessageId: null, threadId: null };
    }
    const idempotencyKey = draftRow.contentHash.slice(0, 64);
    try {
      const payload = draftRow.providerDraftId
        ? await agentmailRequest(
            `inboxes/${encodeURIComponent(draftRow.agentmailInboxId)}/drafts/${encodeURIComponent(draftRow.providerDraftId)}/send`,
            { method: "POST", idempotencyKey },
          )
        : await agentmailRequest(`inboxes/${encodeURIComponent(draftRow.agentmailInboxId)}/messages/send`, {
            method: "POST",
            idempotencyKey,
            body: { to: [draftRow.recipient], subject: draftRow.subject, text: draftRow.body },
          });
      const providerMessageId = typeof payload.message_id === "string" ? payload.message_id : null;
      const threadId = typeof payload.thread_id === "string" ? payload.thread_id : null;
      if (!providerMessageId || !threadId) throw new Error("AgentMail returned no message reference.");
      await ctx.runMutation(internal.outreachStore.markSent, {
        actionId: draftRow._id,
        providerMessageId,
        threadId,
      });
      return { actionId: draftRow._id, status: "sent" as const, providerMessageId, threadId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "AgentMail send failed.";
      const unverified = message.includes("rate limit") || message.includes("temporarily");
      await ctx.runMutation(internal.outreachStore.markSendFailed, {
        actionId: draftRow._id,
        errorSummary: message,
        unverified,
      });
      throw error;
    }
  },
});

export const provisionInbox = action({
  args: {
    workspaceId: v.string(),
    clientRequestId: v.string(),
    displayName: v.union(v.string(), v.null()),
  },
  returns: v.object({ inboxId: v.id("agentInboxes"), agentmailInboxId: v.string(), email: v.string() }),
  handler: async (ctx, args) => {
    if (!args.clientRequestId.trim() || args.clientRequestId.length > 160) {
      throw new Error("INVALID_ARGUMENT: clientRequestId is required.");
    }
    const payload = await agentmailRequest("inboxes", {
      method: "POST",
      body: {
        client_id: args.clientRequestId,
        ...(args.displayName ? { display_name: args.displayName } : {}),
      },
    });
    const agentmailInboxId = typeof payload.inbox_id === "string" ? payload.inbox_id : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    const displayName = typeof payload.display_name === "string" ? payload.display_name : null;
    if (!agentmailInboxId || !email) throw new Error("AgentMail returned no usable inbox reference.");
    const inboxRecordId: Id<"agentInboxes"> = await ctx.runMutation(api.outreachStore.linkInbox, {
      workspaceId: args.workspaceId,
      agentmailInboxId,
      email,
      displayName,
    });
    return { inboxId: inboxRecordId, agentmailInboxId, email };
  },
});
