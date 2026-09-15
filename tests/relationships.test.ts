import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { contentHash } from "../convex/hash";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";
const OTHER_WORKSPACE = "attacker-workspace";
const dayMs = 24 * 60 * 60 * 1000;

// The AgentMail client is constructed at module load, so the mock must exist
// before the glob imports run (same pattern as the trust suite).
vi.mock("@agentmail/convex", () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  (globalThis as Record<string, unknown>).__agentmailSent = sent;
  class AgentMail {
    constructor(_component: unknown) {}
    async sendMessage(_ctx: unknown, _inboxId: string, payload: { to: string; subject: string; text: string }) {
      sent.push(payload);
      return `out_${sent.length}`;
    }
    async replyToMessage(_ctx: unknown, _inboxId: string, _messageId: string, payload: { to: string; subject: string; text: string }) {
      sent.push(payload);
      return `out_${sent.length}`;
    }
    async status() {
      return { status: "sent", agentmailMessageId: "msg_123", threadId: "thread_123" };
    }
  }
  return { AgentMail, verifyAgentMailWebhook: () => ({}) };
});

function sentCalls() {
  return (globalThis as Record<string, unknown>).__agentmailSent as Array<{ to: string; subject: string; text: string }>;
}

function llmReply(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    text: async () => "",
  };
}

/** Seeds a mission, run, inbox, sourced match, and one approved-ready draft. */
async function seedRelationship(t: TestT, opts?: { workspace?: string }) {
  const workspace = opts?.workspace ?? WORKSPACE;
  return t.run(async (ctx) => {
    const now = Date.now();
    const recipient = "jordan@example.test";
    const subject = "Partnership intro";
    const body = "Hi Jordan — I read your launch post and wanted to reach out about collaborating on the dashboard rebuild.";
    const hash = await contentHash(recipient, subject, body);
    const missionId = await ctx.db.insert("missions", {
      workspaceId: workspace,
      title: "Find design partners",
      rawGoal: "Find companies that need React development",
      mode: "customer" as const,
      status: "running" as const,
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "one positive reply",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentRuns", {
      missionId,
      status: "waiting" as const,
      currentStage: "wait" as const,
      checkpointVersion: 1,
      activeInterruption: null,
      nextWakeAt: null,
      retryCount: 0,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentInboxes", {
      workspaceId: workspace,
      agentmailInboxId: "inbox_test",
      email: "radar@example.test",
      displayName: null,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = await ctx.db.insert("researchJobs", {
      missionId, runId: (await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).first())!._id,
      requestId: `req-${now}`, operation: "search", query: "acme", status: "complete", provider: "firecrawl",
      providerRequestId: null, crawlId: null, crawlStatus: null, errorCode: null, resultCount: 1, errorSummary: null,
      createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId, jobId, url: "https://acme.example.com/careers", title: "Acme careers",
      sourceType: "scraped_page",
      excerpt: "Acme is hiring a frontend engineer.",
      content: "Acme Corp is hiring a frontend engineer to rebuild its analytics dashboard. Contact hiring@acme.example.com.",
      fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null,
      processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now,
    });
    const discoveryId = await ctx.db.insert("discoveries", {
      missionId, sourceId, subject: "Acme is hiring a frontend engineer", signal: "hiring",
      publishedAt: null, extractedFields: [], createdAt: now, updatedAt: now,
    });
    const matchId = await ctx.db.insert("matches", {
      missionId, discoveryId, sourceId, label: "promising" as const,
      positiveEvidence: ["Hiring a frontend engineer for a dashboard rebuild"],
      unknowns: [], risks: [], freshness: "fresh", recommendedAction: "Send a grounded intro",
      createdAt: now, updatedAt: now,
    });
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId, matchId, workspaceId: workspace, agentmailInboxId: "inbox_test",
      clientRequestId: `seed-${now}-${Math.random().toString(36).slice(2, 8)}`,
      providerDraftId: null, recipient, subject, body, contentHash: hash,
      capability: "send_email" as const, status: "draft" as const,
      outboundId: null, providerMessageId: null, threadId: null, errorSummary: null,
      createdAt: now, updatedAt: now,
    });
    return { missionId, matchId, actionId, sourceId, recipient, subject, body };
  });
}

/** Approves and sends the seeded draft so the relationship pipeline has a row. */
async function sendIntro(t: TestT, actionId: never) {
  await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });
  return t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId });
}

function outcomesFor(t: TestT, missionId: never) {
  return t.run(async (ctx) => ctx.db.query("outcomes").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect());
}

function sequencesFor(t: TestT, matchId: never) {
  return t.run(async (ctx) => ctx.db.query("outreachSequences").withIndex("by_matchId", (q) => q.eq("matchId", matchId)).collect());
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  // The AgentMail mock's send log survives across tests in this file.
  const sent = (globalThis as Record<string, unknown>).__agentmailSent;
  if (Array.isArray(sent)) sent.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("relationship pipeline (docs/execution-plan.md Phase 3)", () => {
  it("records a contacted relationship and opens a sequence on the first approved send", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);

    const outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].stage).toBe("contacted");
    expect(outcomes[0].nextAction).toMatch(/reply/i);

    const sequences = await sequencesFor(t, matchId as never);
    expect(sequences).toHaveLength(1);
    expect(sequences[0].status).toBe("active");
    expect(sequences[0].steps[0]).toMatchObject({ index: 0, trigger: "initial", status: "sent" });
    expect(sequences[0].steps.filter((step) => step.status === "pending")).toHaveLength(2);
    // Opening a sequence schedules a no-reply follow-up but sends nothing extra.
    expect(sentCalls()).toHaveLength(1);
  });

  it("advances the relationship to replied when inbound mail lands on the thread", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);

    await t.mutation(api.inbox.ingestEvent, {
      eventId: "evt_reply_1",
      eventType: "message.received",
      message: {
        inbox_id: "inbox_test",
        thread_id: "thread_123",
        message_id: "in_1",
        from_: ["jordan@example.test"],
        to: ["radar@example.test"],
        subject: "Re: Partnership intro",
        preview: "Sounds interesting — can you share more about the timeline?",
        timestamp: new Date().toISOString(),
      },
      thread: {}, send: {}, delivery: {}, bounce: {}, reject: {}, complaint: {},
    });

    const outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].stage).toBe("replied");
    expect(outcomes[0].linkedThreadId).toBe("thread_123");

    // The thread Radar opened inherits the mission, so it is not orphaned.
    const thread = await t.run(async (ctx) =>
      ctx.db.query("inboxThreads").withIndex("by_threadId", (q) => q.eq("threadId", "thread_123")).first());
    expect(thread?.missionId).toBe(missionId);
  });

  it("maps reply meaning onto the pipeline stage, including a deferral follow-up", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    await t.mutation(api.inbox.ingestEvent, {
      eventId: "evt_reply_2", eventType: "message.received",
      message: {
        inbox_id: "inbox_test", thread_id: "thread_123", message_id: "in_2",
        from_: ["jordan@example.test"], to: ["radar@example.test"],
        subject: "Re: Partnership intro", preview: "Let's talk next month.", timestamp: new Date().toISOString(),
      },
      thread: {}, send: {}, delivery: {}, bounce: {}, reject: {}, complaint: {},
    });

    await t.mutation(internal.relationships.applyReplyStage, {
      workspaceId: WORKSPACE, threadId: "thread_123", label: "interested", summary: "They want to talk.",
    });
    let outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes[0].stage).toBe("engaged");

    await t.mutation(internal.relationships.applyReplyStage, {
      workspaceId: WORKSPACE, threadId: "thread_123", label: "not_now", summary: "Deferred by a month.",
    });
    outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes[0].stage).toBe("dormant");
    const followUps = await t.run(async (ctx) =>
      ctx.db.query("followUps").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect());
    expect(followUps.some((row) => row.note.includes("timing"))).toBe(true);
  });

  it("never moves a stage backwards on a stale event and never duplicates history", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    const outcomes = await outcomesFor(t, missionId as never);
    const outcomeId = outcomes[0]._id;

    await t.mutation(internal.relationships.applyReplyStage, {
      workspaceId: WORKSPACE, threadId: "thread_123", label: "interested", summary: "Engaged.",
    });
    // A replay of the earlier "contacted" state must not regress the stage, and
    // a replayed event must not duplicate history.
    await t.run(async (ctx) => {
      const { applyStage } = await import("../convex/outcomes");
      await applyStage(ctx, { outcomeId, stage: "contacted", summary: "Late contact event.", eventType: "action.sent" });
      await applyStage(ctx, { outcomeId, stage: "engaged", summary: "Replayed event.", eventType: "relationship.stage" });
      await applyStage(ctx, { outcomeId, stage: "engaged", summary: "Replayed event.", eventType: "relationship.stage" });
    });

    const after = await outcomesFor(t, missionId as never);
    expect(after[0].stage).toBe("engaged");
    expect(after[0].timeline.filter((event) => event.summary === "Replayed event.")).toHaveLength(1);
  });

  it("runs the follow-up lifecycle: schedule → due → snooze → done", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    const outcomeId = (await outcomesFor(t, missionId as never))[0]._id;

    const followUpId = await t.mutation(api.relationships.scheduleFollowUp, {
      workspaceId: WORKSPACE, missionId, outcomeId, matchId, threadId: null,
      note: "Ping after their launch", dueAt: Date.now() + 2 * dayMs,
    });

    const swept = await t.mutation(internal.sequenceRunner.sweepDueFollowUps, { now: Date.now() + 5 * dayMs });
    expect(swept.marked).toBeGreaterThanOrEqual(1);
    // A sequence exists for this match, so the sweep queues follow-up steps.
    expect(swept.queued).toBeGreaterThanOrEqual(1);
    expect(sentCalls()).toHaveLength(1); // still only the intro

    const due = await t.run(async (ctx) => ctx.db.get(followUpId));
    expect(due?.status).toBe("due");

    // The sweep queues the step written first (the no-reply value-add), not the
    // gentle close, so the sequence is drafted in the order it was planned.
    const sequence = await sequencesFor(t, matchId as never);
    expect(sequence[0].steps.map((step) => step.index)).toEqual([0, 1, 2]);

    await t.mutation(api.relationships.snoozeFollowUp, {
      workspaceId: WORKSPACE, followUpId, dueAt: Date.now() + 4 * dayMs,
    });
    const snoozed = await t.run(async (ctx) => ctx.db.get(followUpId));
    expect(snoozed?.status).toBe("scheduled");
    expect(snoozed!.dueAt).toBeGreaterThan(Date.now() + 3 * dayMs);

    await t.mutation(api.relationships.completeFollowUp, { workspaceId: WORKSPACE, followUpId });
    const open = await t.query(api.relationships.followUpsForMission, { workspaceId: WORKSPACE, missionId });
    expect(open.some((row) => row._id === followUpId)).toBe(false);
  });

  it("queues the next sequence step for the matching trigger", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    const sequenceId = (await sequencesFor(t, matchId as never))[0]._id;

    const index = await t.mutation(internal.sequenceRunner.queueNextStep, {
      sequenceId, trigger: "followup_due",
    });
    expect(index).toBe(2); // the gentle-close step owns this trigger
    const second = await t.mutation(internal.sequenceRunner.queueNextStep, {
      sequenceId, trigger: "no_reply",
    });
    expect(second).toBe(1);
  });

  it("drafts a sequence step as a draft that still needs its own approval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmReply({
      subject: "Re: Partnership intro",
      body: "Following up briefly — is the dashboard rebuild still on your roadmap this quarter?",
    })));
    const t = convexTest(schema, convexModules);
    const { actionId, missionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    const sequenceId = (await sequencesFor(t, matchId as never))[0]._id;

    const drafted = await t.action(internal.ai.draftSequenceStep, { sequenceId, index: 1 });
    expect(drafted.draftId).not.toBeNull();
    const draft = await t.run(async (ctx) => ctx.db.get(drafted.draftId!));
    expect(draft?.status).toBe("draft");
    expect(draft?.providerMessageId).toBeNull();
    expect(sentCalls()).toHaveLength(1); // drafting never sends

    const sequence = await t.run(async (ctx) => ctx.db.get(sequenceId));
    expect(sequence?.steps[1].status).toBe("draft_ready");
    expect(sequence?.steps[1].draftId).toBe(drafted.draftId);

    // The queued step is not sendable without an approval of its own bytes.
    await expect(t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId: drafted.draftId! }))
      .rejects.toThrow(/APPROVAL_REQUIRED/);
    expect(sentCalls()).toHaveLength(1);

    // Approving only this step sends only this step.
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId: drafted.draftId! });
    const sent = await t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId: drafted.draftId! });
    expect(sent.status).toBe("sent");
    expect(sentCalls()).toHaveLength(2);
    const after = await t.run(async (ctx) => ctx.db.get(sequenceId));
    expect(after?.steps[1].status).toBe("sent");
    expect(after?.steps[2].status).toBe("pending"); // one approval never approves the next

    const missionOutcomes = await outcomesFor(t, missionId as never);
    expect(missionOutcomes).toHaveLength(1); // no duplicate relationship per step
  });

  it("keeps one active sequence per match and completes it when every step is sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmReply({
      subject: "Re: Partnership intro",
      body: "One last note — happy to close the loop whenever the timing is right for you.",
    })));
    const t = convexTest(schema, convexModules);
    const { actionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);

    // A second send on the same match must not open a second sequence.
    const sequenceId = (await sequencesFor(t, matchId as never))[0]._id;
    await t.mutation(internal.relationships.ensureSequence, {
      workspaceId: WORKSPACE, missionId: (await t.run(async (ctx) => ctx.db.get(sequenceId)))!.missionId,
      matchId, agentmailInboxId: "inbox_test", actionId,
    });
    expect(await sequencesFor(t, matchId as never)).toHaveLength(1);

    const first = await t.action(internal.ai.draftSequenceStep, { sequenceId, index: 1 });
    const second = await t.action(internal.ai.draftSequenceStep, { sequenceId, index: 2 });
    for (const draftId of [first.draftId!, second.draftId!]) {
      await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId: draftId });
      await t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId: draftId });
    }
    const sequence = await t.run(async (ctx) => ctx.db.get(sequenceId));
    expect(sequence?.steps.every((step) => step.status === "sent")).toBe(true);
    expect(sequence?.status).toBe("complete");
  });

  it("records a meeting as a first-class pipeline event", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, missionId, matchId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    const outcomeId = (await outcomesFor(t, missionId as never))[0]._id;

    await t.mutation(api.relationships.recordMeeting, {
      workspaceId: WORKSPACE, missionId, outcomeId, matchId,
      counterpart: "Jordan", scheduledAt: Date.now() + dayMs, notes: "Agreed to scope a pilot.",
    });

    const outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes[0].stage).toBe("meeting");
    expect(outcomes[0].timeline.some((event) => event.type === "relationship.meeting")).toBe(true);
    const meetings = await t.query(api.relationships.meetingsForMission, { workspaceId: WORKSPACE, missionId });
    expect(meetings).toHaveLength(1);
    expect(meetings[0].counterpart).toBe("Jordan");
  });

  it("rejects cross-workspace pipeline writes", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedRelationship(t);
    await expect(t.mutation(api.relationships.scheduleFollowUp, {
      workspaceId: OTHER_WORKSPACE, missionId, outcomeId: null, matchId: null, threadId: null,
      note: "sneaky", dueAt: Date.now() + dayMs,
    })).rejects.toThrow(/FORBIDDEN_SCOPE/);
  });

  it("suggestNextStep advances the relationship and schedules a follow-up from a deferral", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmReply({
      relationshipStage: "dormant",
      nextStep: "Follow up when their new quarter starts.",
      followUpInDays: 30,
      suggestedReply: "Of course — I'll check back in when the new quarter starts.",
    })));
    const t = convexTest(schema, convexModules);
    const { actionId, missionId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    await t.mutation(api.inbox.ingestEvent, {
      eventId: "evt_reply_3", eventType: "message.received",
      message: {
        inbox_id: "inbox_test", thread_id: "thread_123", message_id: "in_3",
        from_: ["jordan@example.test"], to: ["radar@example.test"],
        subject: "Re: Partnership intro", preview: "Not now — ping me next quarter.",
        timestamp: new Date().toISOString(),
      },
      thread: {}, send: {}, delivery: {}, bounce: {}, reject: {}, complaint: {},
    });
    const messageId = (await t.run(async (ctx) =>
      ctx.db.query("inboxMessages").withIndex("by_messageId", (q) => q.eq("messageId", "in_3")).first()))!._id;
    await t.mutation(internal.outreachStore.saveClassification, {
      messageId, label: "not_now", confidence: 0.9, summary: "Politely deferred to next quarter.",
      suggestedNextAction: "Wait for next quarter.", suggestedDraftId: null, provider: "openai", model: "test-model",
    });

    const result = await t.action(internal.ai.suggestNextStep, { workspaceId: WORKSPACE, messageId });
    expect(result.stage).toBe("dormant");
    expect(result.outcomeId).toBe((await outcomesFor(t, missionId as never))[0]._id);
    expect(result.followUpAt).toBeGreaterThan(Date.now() + 20 * dayMs);

    const outcomes = await outcomesFor(t, missionId as never);
    expect(outcomes[0].stage).toBe("dormant");
    const followUps = await t.run(async (ctx) =>
      ctx.db.query("followUps").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect());
    expect(followUps.some((row) => row.outcomeId === outcomes[0]._id)).toBe(true);
  });

  it("creates no suggested draft when the next step is a clear decline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmReply({
      relationshipStage: "lost",
      nextStep: "Close the loop politely and stop outreach.",
      followUpInDays: 0,
      suggestedReply: "Thanks for the straight answer — I'll leave it there.",
    })));
    const t = convexTest(schema, convexModules);
    const { actionId, missionId } = await seedRelationship(t);
    await sendIntro(t, actionId as never);
    await t.mutation(api.inbox.ingestEvent, {
      eventId: "evt_reply_4", eventType: "message.received",
      message: {
        inbox_id: "inbox_test", thread_id: "thread_123", message_id: "in_4",
        from_: ["jordan@example.test"], to: ["radar@example.test"],
        subject: "Re: Partnership intro", preview: "No thanks, not interested.",
        timestamp: new Date().toISOString(),
      },
      thread: {}, send: {}, delivery: {}, bounce: {}, reject: {}, complaint: {},
    });
    const messageId = (await t.run(async (ctx) =>
      ctx.db.query("inboxMessages").withIndex("by_messageId", (q) => q.eq("messageId", "in_4")).first()))!._id;
    await t.mutation(internal.outreachStore.saveClassification, {
      messageId, label: "negative", confidence: 0.95, summary: "Declined outright.",
      suggestedNextAction: "Stop outreach.", suggestedDraftId: null, provider: "openai", model: "test-model",
    });

    const result = await t.action(internal.ai.suggestNextStep, { workspaceId: WORKSPACE, messageId });
    expect(result.stage).toBe("lost");
    expect(result.draftId).toBeNull();
    const drafts = await t.run(async (ctx) =>
      ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect());
    expect(drafts).toHaveLength(1); // only the intro we already sent
  });
});
