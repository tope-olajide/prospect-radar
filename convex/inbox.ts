import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
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
}

/** App-owned ingest for one verified AgentMail event. Idempotent by event_id. */
export const ingestEvent = mutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    message: v.any(),
    thread: v.any(),
    send: v.any(),
    delivery: v.any(),
    bounce: v.any(),
    reject: v.any(),
    complaint: v.any(),
  },
  returns: v.object({ accepted: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("providerEvents")
      .withIndex("by_provider_and_eventId", (q) => q.eq("provider", "agentmail").eq("eventId", args.eventId))
      .first();
    if (existing) return { accepted: false };
    await ctx.db.insert("providerEvents", {
      provider: "agentmail",
      eventId: args.eventId,
      eventType: args.eventType,
      createdAt: Date.now(),
    });

    if (args.eventType === "message.received" || args.eventType.startsWith("message.received.")) {
      const message = isRecord(args.message) ? args.message : {};
      const thread = isRecord(args.thread) ? args.thread : {};
      const inboxMessageId: Id<"inboxMessages"> | null = await ctx.runMutation(internal.inbox.recordInboundMessage, {
        eventId: args.eventId,
        eventType: args.eventType,
        inboxId: asString(message.inbox_id),
        threadId: asString(message.thread_id) || asString(thread.thread_id),
        messageId: asString(message.message_id),
        sender: asStringArray(message.from_)[0] ?? asString(message.from, ""),
        recipients: asStringArray(message.to),
        subject: asString(message.subject),
        preview: asString(message.preview) || boundedText(asString(message.text), 280),
        occurredAt: parseTimestamp(message.timestamp, Date.now()),
      });
      if (inboxMessageId) {
        await ctx.scheduler.runAfter(0, internal.inbox.classifyInboundMessage, {
          workspaceId: "demo-workspace",
          messageId: inboxMessageId,
        });
      }
    } else if (
      args.eventType === "message.sent" ||
      args.eventType === "message.delivered" ||
      args.eventType === "message.bounced" ||
      args.eventType === "message.rejected" ||
      args.eventType === "message.complained"
    ) {
      const detail = isRecord(args.send) ? args.send
        : isRecord(args.delivery) ? args.delivery
        : isRecord(args.bounce) ? args.bounce
        : isRecord(args.reject) ? args.reject
        : isRecord(args.complaint) ? args.complaint
        : {};
      await ctx.runMutation(internal.inbox.recordDeliveryEvent, {
        eventId: args.eventId,
        eventType: args.eventType,
        inboxId: asString(detail.inbox_id),
        threadId: asString(detail.thread_id),
        messageId: asString(detail.message_id),
        occurredAt: parseTimestamp(detail.timestamp, Date.now()),
      });
    }
    return { accepted: true };
  },
});

export const classifyInboundMessage = internalAction({
  args: { workspaceId: v.string(), messageId: v.id("inboxMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runAction(api.outreach.classifyReply, args);
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
        labels: existingThread.labels.includes("replied") ? existingThread.labels : [...existingThread.labels, "replied"],
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
        const stageOrder = ["intake", "interpret", "plan", "discover", "evaluate", "approval", "execute", "wait", "complete"];
        if (stageOrder.indexOf(run.currentStage) < stageOrder.indexOf("wait")) {
          await ctx.db.patch(run._id, { nextWakeAt: now, updatedAt: now });
        }
      }
    }
    return messageId;
  },
});

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
    const inserted = await ctx.db.insert("providerEvents", {
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
    return inserted;
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

const threadLabel = v.union(
  v.literal("new"),
  v.literal("approved"),
  v.literal("waiting"),
  v.literal("reply"),
  v.literal("closed"),
);

export const setLabel = mutation({
  args: { workspaceId: v.string(), threadId: v.id("inboxThreads"), label: threadLabel, set: v.boolean() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: thread is not in this workspace.");
    }
    const labels = args.set
      ? Array.from(new Set([...thread.labels, args.label]))
      : thread.labels.filter((label) => label !== args.label);
    await ctx.db.patch(thread._id, { labels, updatedAt: Date.now() });
    return labels;
  },
});

export const threadForWorkspace = internalQuery({
  args: { workspaceId: v.string(), threadId: v.string() },
  returns: v.union(v.id("inboxThreads"), v.null()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.query("inboxThreads")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();
    return thread && thread.workspaceId === args.workspaceId ? thread._id : null;
  },
});
