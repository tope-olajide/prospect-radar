import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { contentHash } from "../convex/hash";

/**
 * The autonomy contract.
 *
 * These tests exist because the mission loop used to be driven by the UI: a run
 * reached the approval gate with nothing to approve, and a person had to pick a
 * match and press "draft". The properties pinned here are the ones that make
 * Radar a background agent rather than a workflow tool:
 *
 *   1. approving content resumes the mission — execution is scheduled by the
 *      state machine, not by a page calling `send`;
 *   2. the agent proposes an action only when it has somewhere to send from and
 *      a counterpart it can actually reach — otherwise it asks.
 *
 * Both use real persisted state. Nothing here fakes progress.
 */

const convexModules = import.meta.glob("../convex/**/*.*s");
type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

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

let lastTest: TestT | null = null;

/** A mission parked at the approval gate, with a draft that has not been approved. */
async function seedGate(t: TestT, opts?: { inbox?: boolean }) {
  lastTest = t;
  const withInbox = opts?.inbox ?? true;
  const now = Date.now();
  const recipient = "jordan@example.test";
  const subject = "Partnership intro";
  const body = "Hi Jordan — I read your launch post and wanted to reach out about collaborating on the rollout.";
  const hash = await contentHash(recipient, subject, body);
  return t.run(async (ctx) => {
    const missionId = await ctx.db.insert("missions", {
      workspaceId: WORKSPACE,
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
    if (withInbox) {
      await ctx.db.insert("agentInboxes", {
        workspaceId: WORKSPACE,
        agentmailInboxId: "inbox_test",
        email: "radar@example.test",
        displayName: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId,
      matchId: null,
      workspaceId: WORKSPACE,
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

async function runRow(t: TestT, missionId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", missionId as never))
      .first(),
  );
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  const sent = sentCalls();
  if (Array.isArray(sent)) sent.length = 0;
});

afterEach(async () => {
  await lastTest?.finishInProgressScheduledFunctions();
  lastTest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("approval resumes the mission (autonomous execution)", () => {
  it("executes approved content without a page calling send", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, actionId, recipient, subject, body } = await seedGate(t);

    // The only human act in this test is the approval.
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });

    // Approving content moves the parked run onto the execute stage — the
    // mission resumes because the state machine says so, not because a page
    // called `send`. Read before draining so scheduler timing cannot mask it.
    const parked = await runRow(t, missionId);
    expect({ stage: parked?.currentStage, status: parked?.status }).toEqual({ stage: "execute", status: "active" });

    // Run the stage the state machine scheduled. convex-test does not tick
    // `runAfter(0)` jobs from wall-clock time, so the scheduled `runStage` is
    // invoked here by the same name the scheduler would use — no page mutation
    // is involved, and the assertion above is what proves approval itself moved
    // the run. This only executes the stage; it does not decide anything.
    await t.action(internal.missionOrchestrator.runStage, { missionId });

    // ...and the mission ended where an agent with nothing outstanding belongs:
    // observing, then parked on a scheduled wake with a reply able to interrupt
    // it. Reaching `wait` rather than staying at `execute` is only possible if
    // the observation stage really ran.
    const run = await runRow(t, missionId);
    expect({ stage: run?.currentStage, status: run?.status }).toEqual({ stage: "wait", status: "waiting" });

    const draft = await t.run(async (ctx) => ctx.db.get(actionId));
    expect(draft?.status).toBe("sent");

    const sent = sentCalls() ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ to: recipient, subject, text: body });
    const steps = await t.run(async (ctx) =>
      ctx.db.query("runSteps").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect(),
    );
    expect(steps.some((step) => step.stage === "observe" || step.stage === "execute")).toBe(true);
  });

  it("keeps the approval contract: an expired approval executes nothing", async () => {
    const t = convexTest(schema, convexModules);
    const { actionId } = await seedGate(t);
    await t.mutation(api.outreachStore.approve, { workspaceId: WORKSPACE, actionId });
    await t.finishInProgressScheduledFunctions();

    // Simulate the approval lapsing before the agent got to it.
    await t.run(async (ctx) => {
      const approval = await ctx.db
        .query("approvals")
        .withIndex("by_actionId", (q) => q.eq("actionId", actionId))
        .first();
      if (approval) await ctx.db.patch(approval._id, { expiresAt: Date.now() - 1000 });
    });

    await expect(
      t.action(api.outreach.send, { workspaceId: WORKSPACE, actionId }),
    ).rejects.toThrow(/APPROVAL_STALE/);
  });
});

describe("the agent proposes actions on its own terms", () => {
  it("refuses to propose without a sending inbox, and drafts nothing", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedGate(t, { inbox: false });

    const result = await t.action(internal.outreach.proposeForMission, { missionId });

    expect(result).toEqual({ proposed: 0, reason: "no_inbox" });
    const drafts = await t.run(async (ctx) => ctx.db.query("actionDrafts").collect());
    expect(drafts).toHaveLength(1); // only the seeded draft; no invented recipient
  });

  it("proposes nothing when no match has a verified reachable channel", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedGate(t);

    const result = await t.action(internal.outreach.proposeForMission, { missionId });

    // An inbox exists, but no match with an email route does: Radar asks rather
    // than addressing a message to a counterpart it cannot reach.
    expect(result).toEqual({ proposed: 0, reason: "no_reachable_match" });
  });
});
