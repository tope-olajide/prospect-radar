import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { contentHash } from "../convex/hash";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";
const OTHER_WORKSPACE = "attacker-workspace";

// The component client is replaced wholesale: outreach.ts constructs it at
// module load, so the mock must exist before the glob imports run.
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
  return {
    AgentMail,
    // http.ts imports this; never invoked in these tests.
    verifyAgentMailWebhook: () => ({}),
  };
});

function sentCalls() {
  return (globalThis as Record<string, unknown>).__agentmailSent as Array<{ to: string; subject: string; text: string }>;
}

// Approval resumes the mission, so an approved draft can be executed by a
// scheduled function rather than by a page calling `send`. convex-test leaves
// that function queued unless it is drained, which would let one test's send
// land while the next test is running. Tracking the instance lets each test
// finish its own scheduled work before the file moves on.
let lastTest: TestT | null = null;

/** Seeds a mission + inbox + draft whose stored hash is the real content hash. */
async function seedDraft(t: TestT, opts?: { workspace?: string }) {
  lastTest = t;
  const workspace = opts?.workspace ?? WORKSPACE;
  return t.run(async (ctx) => {
    const now = Date.now();
    const recipient = "jordan@example.test";
    const subject = "Partnership intro";
    const body = "Hi Jordan — I read your launch post and wanted to reach out directly about collaborating.";
    const hash = await contentHash(recipient, subject, body);
    const missionId = await ctx.db.insert("missions", {
      workspaceId: workspace,
      title: "Seed mission",
      rawGoal: "Find design partners",
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
      status: "active" as const,
      currentStage: "approval" as const,
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
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId,
      matchId: null,
      workspaceId: workspace,
      agentmailInboxId: "inbox_test",
      clientRequestId: `seed-${now}-${Math.random().toString(36).slice(2, 8)}`,
      providerDraftId: null,
      recipient,
      subject,
      body,
      contentHash: hash,
      capability: "send_email" as const,
      status: "draft" as const,
      outboundId: null,
      providerMessageId: null,
      threadId: null,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    return { missionId, actionId, recipient, subject, body };
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  // The AgentMail double records into a module-level array that lives for the
  // whole file. A send scheduled by one test (approval now resumes the mission,
  // so an approved draft can execute without a page calling `send`) would
  // otherwise be counted as a side effect of the next test. Each test must
  // observe only its own sends.
  // The mock factory runs lazily, so the array may not exist until the first
  // test imports the mocked module.
  const sent = sentCalls();
  if (Array.isArray(sent)) sent.length = 0;
});

afterEach(async () => {
  // Drain whatever the test scheduled, inside the test that caused it.
  await lastTest?.finishInProgressScheduledFunctions();
  lastTest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("approval enforcement (trust tests)", () => {
  it("rejects a send from another workspace even with an active approval", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId } = await seedDraft(t, { workspace: WORKSPACE });
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });

    await expect(
      t.action(api.outreach.send, { workspaceId: OTHER_WORKSPACE, actionId }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);

    const draft = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(draft?.status).toBe("approved"); // unchanged, nothing sent
    expect(sentCalls()).toHaveLength(0);
  });

  it("refuses to send without any approval and records no side effects", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId } = await seedDraft(t);

    await expect(t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId })).rejects.toThrow(
      /APPROVAL_REQUIRED/,
    );

    const draft = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(draft?.status).toBe("draft");
    const approvals = await t.run(async (ctx) => ctx.db.query("approvals").collect());
    expect(approvals).toHaveLength(0);
    const outcomes = await t.run(async (ctx) => ctx.db.query("outcomes").collect());
    expect(outcomes).toHaveLength(0);
    expect(sentCalls()).toHaveLength(0);
  });

  it("blocks a send when draft content is mutated after approval (hash mismatch)", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId } = await seedDraft(t);
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });

    // Simulate tampering directly at the storage layer.
    await t.run(async (ctx) => {
      const draft = await ctx.db.get(actionId);
      await ctx.db.patch(actionId, { body: `${draft!.body} FREE UPGRADE CLICK HERE` });
    });

    await expect(t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId })).rejects.toThrow(
      /APPROVAL_STALE/,
    );
    const draft = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(draft?.status).toBe("approved");
    expect(draft?.providerMessageId).toBeNull();
    expect(sentCalls()).toHaveLength(0);
  });

  it("blocks a send with an expired approval", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId } = await seedDraft(t);
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });

    await t.run(async (ctx) => {
      const approval = await ctx.db.query("approvals").withIndex("by_actionId", (q) => q.eq("actionId", actionId)).first();
      await ctx.db.patch(approval!._id, { expiresAt: Date.now() - 1000 });
    });

    await expect(t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId })).rejects.toThrow(
      /APPROVAL_STALE/,
    );
    const draft = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(draft?.status).toBe("approved");
    expect(sentCalls()).toHaveLength(0);
  });

  it("sends exactly the approved bytes once and replays idempotently", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId, recipient, subject, body } = await seedDraft(t);
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });

    const first = await t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId });
    expect(first.status).toBe("sent");
    expect(sentCalls()).toHaveLength(1);
    // The email goes out with the exact approved content, nothing more.
    expect(sentCalls()[0]).toEqual({ to: recipient, subject, text: body });

    const replay = await t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId });
    expect(replay.providerMessageId).toBe(first.providerMessageId);
    expect(sentCalls()).toHaveLength(1); // no duplicate send

    const outcomes = await t.run(async (ctx) => ctx.db.query("outcomes").collect());
    expect(outcomes).toHaveLength(1);
  });

  it("rejects a clientRequestId reuse with different content (IDEMPOTENCY_CONFLICT)", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, recipient } = await seedDraft(t);

    const args = {
      workspaceId: WORKSPACE,
      missionId,
      matchId: null,
      agentmailInboxId: "inbox_test",
      clientRequestId: "fixed-request-key",
      recipient,
      subject: "First subject",
      body: "First body that is long enough to pass validation checks.",
    };
    const first = await t.action(api.outreach.draft, args);
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId: first.actionId });

    await expect(
      t.action(api.outreach.draft, { ...args, subject: "Changed subject" }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });
});

describe("webhook ingest idempotency", () => {
  const baseEvent = {
    eventId: "evt_1",
    eventType: "message.received",
    message: {
      inbox_id: "inbox_test",
      thread_id: "thread_abc",
      message_id: "m1",
      from_: ["sender@example.test"],
      to: ["radar@example.test"],
      subject: "Re: Partnership intro",
      preview: "Thanks for reaching out — I am interested in learning more.",
      timestamp: new Date().toISOString(),
    },
    thread: null,
    send: null,
    delivery: null,
    bounce: null,
    reject: null,
    complaint: null,
  };

  it("accepts an event once and ignores replays by event_id", async () => {
    const t = convexTest(schema, convexModules);
    await seedDraft(t);

    const first = await t.mutation(api.inbox.ingestEvent, baseEvent);
    expect(first.accepted).toBe(true);
    const replay = await t.mutation(api.inbox.ingestEvent, baseEvent);
    expect(replay.accepted).toBe(false);

    const messages = await t.run(async (ctx) => ctx.db.query("inboxMessages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("m1");

    const providerEvents = await t.run(async (ctx) => ctx.db.query("providerEvents").collect());
    expect(providerEvents).toHaveLength(1);
  });

  it("ignores a different event type that reuses a known event_id", async () => {
    const t = convexTest(schema, convexModules);
    await seedDraft(t);
    await t.mutation(api.inbox.ingestEvent, baseEvent);

    const replayAsDelivery = await t.mutation(api.inbox.ingestEvent, {
      ...baseEvent,
      eventType: "message.delivered",
      message: null,
      delivery: { inbox_id: "inbox_test", thread_id: "thread_abc", message_id: "m1" },
    });
    expect(replayAsDelivery.accepted).toBe(false);

    const providerEvents = await t.run(async (ctx) => ctx.db.query("providerEvents").collect());
    expect(providerEvents).toHaveLength(1);
  });
});

describe("inbox labels", () => {
  it("sets and removes doc-defined labels only within the owning workspace", async () => {
    const t = convexTest(schema, convexModules);
    await seedDraft(t);
    const threadId = await t.run(async (ctx) =>
      ctx.db.insert("inboxThreads", {
        workspaceId: WORKSPACE,
        agentmailInboxId: "inbox_test",
        missionId: null,
        matchId: null,
        threadId: "thread_abc",
        labels: ["new"],
        senderSummary: "sender@example.test",
        subject: "Re: Partnership intro",
        preview: "Interested.",
        latestMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await expect(
      t.mutation(api.inbox.setLabel, { workspaceId: OTHER_WORKSPACE, threadId, label: "closed", set: true }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);

    const labeled = await t.mutation(api.inbox.setLabel, { workspaceId: WORKSPACE, threadId, label: "waiting", set: true });
    expect(labeled).toEqual(["new", "waiting"]);
    const removed = await t.mutation(api.inbox.setLabel, { workspaceId: WORKSPACE, threadId, label: "waiting", set: false });
    expect(removed).toEqual(["new"]);
  });
});

describe("context facts", () => {
  it("starts agent-inferred facts unreviewed and requires explicit confirmation", async () => {
    const t = convexTest(schema, convexModules);
    const factId = await t.mutation(internal.context.seedForTest, {
      workspaceId: WORKSPACE,
      missionId: null,
      category: "target_industry",
      value: "Developer tooling startups",
      sourceType: "agent_inference" as const,
    });

    let fact = await t.run(async (ctx) => ctx.db.get(factId));
    expect(fact?.verificationStatus).toBe("unreviewed");

    await t.mutation(api.context.confirm, { workspaceId: WORKSPACE, factId });
    fact = await t.run(async (ctx) => ctx.db.get(factId));
    expect(fact?.verificationStatus).toBe("user_confirmed");
    expect(fact?.confidence).toBe(1);
  });

  it("rejects cross-workspace confirmation, correction, and deletion", async () => {
    const t = convexTest(schema, convexModules);
    const factId = await t.mutation(internal.context.seedForTest, {
      workspaceId: WORKSPACE,
      missionId: null,
      category: "target_industry",
      value: "Developer tooling startups",
      sourceType: "agent_inference" as const,
    });

    await expect(
      t.mutation(api.context.confirm, { workspaceId: OTHER_WORKSPACE, factId }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);
    await expect(
      t.mutation(api.context.correct, { workspaceId: OTHER_WORKSPACE, factId, value: "x" }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);
    await expect(
      t.mutation(api.context.deleteFact, { workspaceId: OTHER_WORKSPACE, factId }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);

    const fact = await t.run(async (ctx) => ctx.db.get(factId));
    expect(fact).not.toBeNull();
  });
});

/**
 * The authority boundary between a client caller and a machine caller.
 *
 * These exist because a live mission run caught the opposite failure: the
 * workspace guard was tightened for anonymous callers, which also locked out the
 * orchestrator's own server-driven reads. The orchestrator runs inside Convex
 * with no user identity, so anything it reads must be an internal function —
 * public ones resolve the *caller's* authority and a machine caller has none.
 * The test suite never saw it because it drives every function with a synthetic
 * workspace string, so it never exercised a real `workspaces` row.
 */
describe("workspace authority boundary (real workspace row)", () => {
  async function seedRealWorkspace(t: TestT) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      const workspaceId = await ctx.db.insert("workspaces", { ownerId: userId, name: "Real workspace", createdAt: now });
      await ctx.db.insert("contextFacts", {
        workspaceId, missionId: null, category: "skills", value: "React", sourceType: "user_input",
        sourceReference: null, confidence: 1, verificationStatus: "user_confirmed", visibility: "workspace",
        createdAt: now, updatedAt: now,
      });
      return workspaceId;
    });
  }

  it("lets the agent read its own context with no identity, and still refuses the public read", async () => {
    const t = convexTest(schema, convexModules);
    const workspaceId = await seedRealWorkspace(t);

    // Server-driven path (the orchestrator's classifier): must work, or every
    // mission blocks at intake.
    const facts = await t.query(internal.context.factsForAgent, { workspaceId, missionId: null });
    expect(facts.map((fact) => fact.value)).toEqual(["React"]);

    // Client-facing path: a real workspace is not readable without a session.
    await expect(
      t.query(api.context.list, { workspaceId, missionId: null }),
    ).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("lets server-driven research run against a real workspace with no identity", async () => {
    const t = convexTest(schema, convexModules);
    const workspaceId = await seedRealWorkspace(t);

    // The research readers the orchestrator calls are addressed by missionId
    // only, so they carry no session and must still work against a real
    // workspace. (They are read-only projections, not authority checks.)
    const missionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("missions", {
        workspaceId, title: "Real mission", rawGoal: "Real mission", mode: "opportunity", status: "ready",
        constraints: [], sourceScope: "public-web", completionPredicate: "n/a", createdAt: now, updatedAt: now,
      });
    });

    expect(await t.query(api.researchStore.listSources, { missionId })).toEqual([]);
    expect(await t.query(api.researchStore.listMatches, { missionId })).toEqual([]);
    expect(await t.query(api.researchStore.listJobs, { missionId })).toEqual([]);
  });
});
