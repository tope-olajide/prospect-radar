import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { boundedText } from "./hash";
import { recordDeliveryOutcome, recordReplyOutcome } from "./outcomes";

const threadView = v.object({
  _id: v.id("inboxThreads"),
  workspaceId: v.string(),
  agentmailInboxId: v.string(),
  missionId: v.union(v.id("missions"), v.null()),
  matchId: v.union(v.id("matches"), v.null()),
  threadId: v.string(),
  labels: v.array(v.string()),
  senderSummary: v.string(),
  subject: v.string(),
  preview: v.string(),
  latestMessageAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const messageView = v.object({
  _id: v.id("inboxMessages"),
  threadId: v.string(),
  messageId: v.string(),
  eventId: v.string(),
  direction: v.union(v.literal("received"), v.literal("sent")),
  sender: v.string(),
  recipients: v.array(v.string()),
  subject: v.string(),
  preview: v.string(),
  createdAt: v.number(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTimestamp(value: unknown, fallback: number) {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}export const agentmailWebhook = httpAction(async (ctx, request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing webhook signature headers", { status: 400 });
  }
  const rawBody = await request.text();

  let verified: Record<string, unknown>;
  try {
    verified = await ctx.runAction(internal.inboxVerify.verifyEvent, {
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook verification failed";
    if (message.includes("not configured")) return new Response(message, { status: 500 });
    return new Response("Invalid webhook signature", { status: 400 });
  }

  const eventType = asString(verified.event_type);
  const eventId = asString(verified.event_id);
  if (!eventType || !eventId) return new Response("Webhook payload is missing event identity", { status: 400 });

    const accepted = await ctx.runMutation(internal.inbox.recordEvent, {
      eventId,
      eventType,
    });
    if (!accepted) return new Response(JSON.stringify({ status: "duplicate_ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    if (eventType === "message.received" || eventType.startsWith("message.received.")) {
      const message = isRecord(verified.message) ? verified.message : {};
      const thread = isRecord(verified.thread) ? verified.thread : {};
      await ctx.runMutation(internal.inbox.recordInboundMessage, {
        eventId,
        eventType,
        inboxId: asString(message.inbox_id),
        threadId: asString(message.thread_id) || asString(thread.thread_id),
        messageId: asString(message.message_id),
        sender: asStringArray(message.from_)[0] ?? asString(message.from, ""),
        recipients: asStringArray(message.to),
        subject: asString(message.subject),
        preview: asString(message.preview) || boundedText(asString(message.text), 280),
        occurredAt: parseTimestamp(message.timestamp, Date.now()),
      });
    } else if (eventType === "message.sent" || eventType === "message.delivered" || eventType === "message.bounced" || eventType === "message.rejected" || eventType === "message.complained") {
      const detail = isRecord(verified.send) ? verified.send
        : isRecord(verified.delivery) ? verified.delivery
        : isRecord(verified.bounce) ? verified.bounce
        : isRecord(verified.reject) ? verified.reject
        : isRecord(verified.complaint) ? verified.complaint
        : {};
      await ctx.runMutation(internal.inbox.recordDeliveryEvent, {
        eventId,
        eventType,
        inboxId: asString(detail.inbox_id),
        threadId: asString(detail.thread_id),
        messageId: asString(detail.message_id),
        occurredAt: parseTimestamp(detail.timestamp, Date.now()),
      });
    }

  return new Response(JSON.stringify({ status: "accepted" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

export const recordEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("providerEvents")
      .withIndex("by_provider_and_eventId", (q) => q.eq("provider", "agentmail").eq("eventId", args.eventId))
      .first();
    if (existing) return false;
    await ctx.db.insert("providerEvents", {
      provider: "agentmail",
      eventId: args.eventId,
      eventType: args.eventType,
      createdAt: Date.now(),
    });
    return true;
  },
});

export const recordInboundMessage = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    inboxId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    sender: v.string(),
    recipients: v.array(v.string()),
    subject: v.string(),
    preview: v.string(),
    occurredAt: v.number(),
  },
  returns: v.union(v.id("inboxMessages"), v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const inbox = args.inboxId
      ? await ctx.db.query("agentInboxes")
        .withIndex("by_agentmailInboxId", (q) => q.eq("agentmailInboxId", args.inboxId))
        .first()
      : null;

    let workspaceId = inbox?.workspaceId ?? null;
    let missionId: Id<"missions"> | null = null;
    let matchId: Id<"matches"> | null = null;
    const existingThread = args.threadId
      ? await ctx.db.query("inboxThreads")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .first()
      : null;
    if (existingThread) {
      workspaceId = existingThread.workspaceId;
      missionId = existingThread.missionId;
      matchId = existingThread.matchId;
    }
    if (!workspaceId) return null;

    const duplicateMessage = await ctx.db.query("inboxMessages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .first();
    if (duplicateMessage) return duplicateMessage._id;

    const messageId = await ctx.db.insert("inboxMessages", {
      workspaceId,
      agentmailInboxId: inbox?.agentmailInboxId ?? args.inboxId,
      missionId,
      threadId: args.threadId,
      messageId: args.messageId,
      eventId: args.eventId,
      direction: "received",
      sender: boundedText(args.sender, 320) || "unknown",
      recipients: args.recipients,
      subject: boundedText(args.subject, 240),
      preview: boundedText(args.preview, 320),
      createdAt: args.occurredAt || now,
    });

    const sender = boundedText(args.sender, 320) || "unknown";
    const subject = boundedText(args.subject, 240);
    const preview = boundedText(args.preview, 320);
    if (existingThread) {
      await ctx.db.patch(existingThread._id, {
        labels: asStringArraySafe(existingThread.labels).includes("replied")
          ? existingThread.labels
          : [...existingThread.labels, "replied"],
        senderSummary: sender,
        subject: subject || existingThread.subject,
        preview: preview || existingThread.preview,
        latestMessageAt: Math.max(existingThread.latestMessageAt, args.occurredAt || now),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("inboxThreads", {
        workspaceId,
        agentmailInboxId: inbox?.agentmailInboxId ?? args.inboxId,
        missionId,
        matchId,
        threadId: args.threadId,
        labels: ["received"],
        senderSummary: sender,
        subject,
        preview,
        latestMessageAt: args.occurredAt || now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (missionId) {
      await recordReplyOutcome(ctx, {
        workspaceId,
        missionId,
        matchId,
        counterpart: sender,
        threadId: args.threadId,
        preview,
      });
    }

    if (missionId) {
      const run = await ctx.db.query("agentRuns")
        .withIndex("by_missionId", (q) => q.eq("missionId", missionId))
        .first();
      if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
        const currentStage = run.currentStage;
        const stageOrder = ["intake", "interpret", "plan", "discover", "evaluate", "approval", "execute", "wait", "complete"];
        if (stageOrder.indexOf(currentStage) < stageOrder.indexOf("wait")) {
          await ctx.db.patch(run._id, { nextWakeAt: now, updatedAt: now });
        }
      }
    }
    return messageId;
  },
});

function asStringArraySafe(value: string[]) {
  return Array.isArray(value) ? value : [];
}

export const recordDeliveryEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    inboxId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    occurredAt: v.number(),
  },
  returns: v.id("providerEvents"),
  handler: async (ctx, args) => {
    const record = await ctx.db.query("providerEvents")
      .withIndex("by_provider_and_eventId", (q) => q.eq("provider", "agentmail").eq("eventId", args.eventId))
      .first();
    if (record) return record._id;
    await ctx.db.insert("providerEvents", {
      provider: "agentmail",
      eventId: args.eventId,
      eventType: args.eventType,
      createdAt: Date.now(),
    });

    const now = Date.now();
    if (args.messageId) {
      const draft = await ctx.db.query("actionDrafts")
        .withIndex("by_providerMessageId", (q) => q.eq("providerMessageId", args.messageId))
        .first();
      if (draft) {
        if (args.threadId && !draft.threadId) {
          await ctx.db.patch(draft._id, { threadId: args.threadId, updatedAt: now });
        }
        if (args.eventType === "message.delivered") {
          await ctx.db.patch(draft._id, { status: "delivered", updatedAt: now });
          await recordDeliveryOutcome(ctx, {
            actionId: draft._id,
            status: "delivered",
            summary: "AgentMail confirmed delivery to the recipient mail server.",
          });
        } else if (args.eventType === "message.bounced" || args.eventType === "message.rejected") {
          await ctx.db.patch(draft._id, { status: "failed", errorSummary: `AgentMail reported ${args.eventType}.`, updatedAt: now });
          await recordDeliveryOutcome(ctx, {
            actionId: draft._id,
            status: "failed",
            summary: `AgentMail reported ${args.eventType} for the approved send.`,
          });
        }
      }
    }
    return args.eventId as Id<"providerEvents">;
  },
});

export const listThreads = query({
  args: { workspaceId: v.string(), missionId: v.union(v.id("missions"), v.null()) },
  returns: v.array(threadView),
  handler: async (ctx, args) => {
    const rows = args.missionId
      ? await ctx.db.query("inboxThreads")
        .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
        .order("desc")
        .take(50)
      : await ctx.db.query("inboxThreads")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .take(50);
    return rows.filter((row) => row.workspaceId === args.workspaceId).map(({ _creationTime, ...row }) => row);
  },
});

export const listMessages = query({
  args: { workspaceId: v.string(), threadId: v.string() },
  returns: v.array(messageView),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("inboxMessages")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .take(100);
    return rows.filter((row) => row.workspaceId === args.workspaceId).map(({ _creationTime, ...row }) => row);
  },
});
