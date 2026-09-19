/**
 * Phase 5 — the objective, the capability registry, and artifacts.
 *
 * Three claims are asserted here, because each one is a place where the agent
 * could quietly lie to the user:
 *
 *   1. What "done" means comes from the mission's plan (read from the user's
 *      own request, and editable by the user), not from the intent label. So
 *      "find me ten clinics" and "get a reply" are different missions.
 *   2. The capability registry is the single source for what Radar can do, read
 *      by the decision layer *and* the UI. The app must never offer an action
 *      the backend would refuse.
 *   3. An authorized artifact travels *inside* the approved action: the approval
 *      hash covers the attachments, so approving a message with a portfolio
 *      attached cannot be replayed as approving one without it — and a withdrawn
 *      authorization fails the send closed rather than sending less than agreed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { contentHash } from "../convex/hash";
import {
  normaliseSuccessKind,
  resolveCapabilities,
  resolveSuccessPolicy,
  type CapabilityRuntime,
  type CandidateInput,
  type MissionInput,
} from "../convex/actionDecision";
import { decideAction } from "../convex/actionDecision";

const convexModules = import.meta.glob("../convex/**/*.*s");
type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";
const OTHER_WORKSPACE = "attacker-workspace";

// The AgentMail client is constructed when `outreach.ts` loads, so the double
// has to exist before the module glob runs. It records the payload so the
// attachment that actually traveled can be asserted, not just that a send
// happened.
vi.mock("@agentmail/convex", () => {
  const sent: Array<{ to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: string }> }> = [];
  (globalThis as Record<string, unknown>).__agentmailSent = sent;
  class AgentMail {
    constructor(_component: unknown) {}
    async sendMessage(_ctx: unknown, _inboxId: string, payload: { to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: string }> }) {
      sent.push(payload);
      return `out_${sent.length}`;
    }
    async replyToMessage(_ctx: unknown, _inboxId: string, _messageId: string, payload: { to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: string }> }) {
      sent.push(payload);
      return `out_${sent.length}`;
    }
    async status() {
      return { status: "sent", agentmailMessageId: "msg_1", threadId: "thread_1" };
    }
  }
  return { AgentMail, verifyAgentMailWebhook: () => ({}) };
});

function sentCalls() {
  const sent = (globalThis as Record<string, unknown>).__agentmailSent as
    | Array<{ to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: string }> }>
    | undefined;
  return sent ?? [];
}

let lastTest: TestT | null = null;

// ── Seeds ─────────────────────────────────────────────────────────────

async function seedMission(
  t: TestT,
  opts: { intent?: string; objective?: { successKind: string; targetCount: number } | null } = {},
) {
  lastTest = t;
  return t.run(async (ctx) => {
    const now = Date.now();
    const missionId = await ctx.db.insert("missions", {
      workspaceId: WORKSPACE,
      title: "Phase 5 seed",
      rawGoal: opts.objective ? "Find ten US veterinary clinics" : "Find customers for my product",
      mode: "customer" as const,
      ...(opts.intent ? { intent: { primary: opts.intent as never, secondary: null, confidence: 0.9, rationale: "test" } } : {}),
      status: "running" as const,
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "one approved action",
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("agentRuns", {
      missionId,
      workspaceId: WORKSPACE,
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
    // `undefined` seeds no plan at all; `null` seeds a plan that states no
    // objective — the shape a plan written before objectives existed has.
    if (opts.objective !== undefined) {
      await ctx.db.insert("missionPlans", {
        missionId,
        normalizedGoal: "Find ten US veterinary clinics that could use my scheduling software",
        mode: "customer" as const,
        successKind: opts.objective ? (opts.objective.successKind as never) : undefined,
        targetCount: opts.objective ? opts.objective.targetCount : undefined,
        mustHave: [],
        niceToHave: [],
        exclusions: [],
        missingFacts: [],
        recommendedSources: [],
        proposedSteps: [],
        completionPredicate: "ten qualified clinics",
        provider: "openai" as const,
        model: "test-model",
        createdAt: now,
      });
    }
    return { missionId, runId };
  });
}

/** One evaluated match, so the completion policy has something to count. */
async function addMatch(t: TestT, missionId: string, label = "stronger") {
  return t.run(async (ctx) => {
    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId: missionId as never, runId: (await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first())?._id as never,
    requestId: `req-${now}`, operation: "search", query: "q",
      status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null,
      crawlStatus: null, errorCode: null, resultCount: 1, errorSummary: null,
      createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId: missionId as never, jobId, url: "https://acme-vet.test", title: "Acme Veterinary",
      sourceType: "search_result", excerpt: "e", content: null, fetchedAt: now, freshness: "fresh",
      firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped",
      errorSummary: null, createdAt: now, updatedAt: now,
    });
    const discoveryId = await ctx.db.insert("discoveries", {
      missionId: missionId as never, sourceId, subject: "Acme Veterinary", signal: "Needs scheduling software",
      publishedAt: null, extractedFields: [], createdAt: now, updatedAt: now,
    });
    return ctx.db.insert("matches", {
      missionId: missionId as never,
      discoveryId,
      sourceId,
      label: label as never,
      positiveEvidence: ["Needs scheduling software", "Multiple locations"],
      unknowns: [],
      risks: [],
      freshness: "fresh",
      recommendedAction: "outreach",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function addInbox(t: TestT) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("agentInboxes", {
      workspaceId: WORKSPACE,
      agentmailInboxId: "inbox_test",
      email: "radar@example.test",
      displayName: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function addSource(t: TestT, opts: { title: string; allowed: boolean; text?: string; url?: string | null }) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("dataSources", {
      workspaceId: WORKSPACE,
      kind: (opts.url ? "website" : "file") as never,
      title: opts.title,
      representationAllowed: opts.allowed,
      url: opts.url ?? null,
      crawlMode: "single" as never,
      crawlId: null,
      fileId: null,
      text: opts.text ?? "Ten years of scheduling-software deployments for multi-site clinics.",
      status: "ready" as never,
      pageCount: 1,
      lastSyncedAt: null,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedApprovedDraft(
  t: TestT,
  opts: { artifactIds: string[]; subject?: string; body?: string; authorized: boolean },
) {
  lastTest = t;
  return t.run(async (ctx) => {
    const now = Date.now();
    const recipient = "jordan@clinic.test";
    const subject = opts.subject ?? "Scheduling software for your clinics";
    const body = opts.body ?? "Hi Jordan — I build scheduling software for multi-site clinics and would like to compare notes.";
    const artifactIds = opts.artifactIds as never[];
    const hash = await contentHash(recipient, subject, body, "send_email", artifactIds as string[]);
    const missionId = await ctx.db.insert("missions", {
      workspaceId: WORKSPACE,
      title: "Artifact seed",
      rawGoal: "Find US veterinary clinics that could use my scheduling software",
      mode: "customer" as const,
      status: "running" as const,
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "one approved action",
      createdAt: now,
      updatedAt: now,
    });
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId,
      matchId: null,
      workspaceId: WORKSPACE,
      agentmailInboxId: "inbox_test",
      clientRequestId: `artifact-${now}-${Math.random().toString(36).slice(2, 8)}`,
      providerDraftId: null,
      recipient,
      subject,
      body,
      contentHash: hash,
      capability: "send_email" as const,
      artifactIds,
      status: "draft" as const,
      outboundId: null,
      providerMessageId: null,
      threadId: null,
      inReplyTo: undefined,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    void opts.authorized;
    return { missionId, actionId, recipient, subject, body, hash };
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  sentCalls().length = 0;
});

afterEach(async () => {
  // Approval resumes the mission, so an approved draft can execute from a
  // scheduled function. Drain each test's own scheduled work before the next.
  if (lastTest) {
    try {
      await lastTest.finishAllScheduledFunctions(() => {});
    } catch {
      // No scheduled work to drain.
    }
    lastTest = null;
  }
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

// ── 1. The objective is the plan's, not the intent's ───────────────────

describe("what done means comes from the plan", () => {
  it("falls back to the intent's default when the plan states no objective", () => {
    expect(resolveSuccessPolicy(null, "find_customer")).toEqual({ kind: "contact_and_wait", targetCount: 1 });
    expect(resolveSuccessPolicy({ successKind: null, targetCount: null }, "find_business")).toEqual({ kind: "find_candidates", targetCount: 3 });
  });

  it("lets a contact-shaped intent become a candidate hunt", () => {
    // "Find ten veterinary clinics" from a user whose intent is find_customer.
    expect(resolveSuccessPolicy({ successKind: "find_candidates", targetCount: 10 }, "find_customer"))
      .toEqual({ kind: "find_candidates", targetCount: 10 });
  });

  it("lets a finding-shaped intent become an outreach mission", () => {
    // "Then contact the best three and get me a reply."
    expect(resolveSuccessPolicy({ successKind: "contact_and_wait", targetCount: 3 }, "find_business"))
      .toEqual({ kind: "contact_and_wait", targetCount: 3 });
  });

  it("bounds the objective so a typo cannot create an impossible mission", () => {
    expect(resolveSuccessPolicy({ successKind: "find_candidates", targetCount: 0 }, "find_customer").targetCount).toBe(1);
    expect(resolveSuccessPolicy({ successKind: "find_candidates", targetCount: 5000 }, "find_customer").targetCount).toBe(100);
    expect(resolveSuccessPolicy({ successKind: "find_candidates" }, "find_business").targetCount).toBe(3);
    // An unrecognised kind is not trusted; the safest reading is "contact and
    // wait", because that requires the user's approval before anything leaves.
    expect(resolveSuccessPolicy({ successKind: "spam_everyone", targetCount: 5 }, "find_customer"))
      .toEqual({ kind: "contact_and_wait", targetCount: 5 });
  });

  it("reads the objective a model phrased its own way instead of failing on it", () => {
    // Live regression: the production model answered with its own wording
    // ("outreach_then_wait") and a strict validator killed the mission at
    // `interpret`. The objective decides how the finish line is measured; it
    // must never be able to fail a mission.
    expect(normaliseSuccessKind("outreach_then_wait")).toBe("contact_and_wait");
    expect(normaliseSuccessKind("contact them and wait for a reply")).toBe("contact_and_wait");
    expect(normaliseSuccessKind("get_in_touch")).toBe("contact_and_wait");
    expect(normaliseSuccessKind("shortlist_candidates")).toBe("find_candidates");
    expect(normaliseSuccessKind("assemble a set of clinics")).toBe("find_candidates");
    expect(normaliseSuccessKind("compare solutions")).toBe("present_solution");
    expect(normaliseSuccessKind("recommend_options")).toBe("present_solution");
    // Exact literals pass through untouched.
    expect(normaliseSuccessKind("contact_and_wait")).toBe("contact_and_wait");
    expect(normaliseSuccessKind("find_candidates")).toBe("find_candidates");
    expect(normaliseSuccessKind("present_solution")).toBe("present_solution");
    // Nothing recognisable is dropped, not guessed at.
    expect(normaliseSuccessKind("¯_(ツ)_/¯")).toBeNull();
    expect(normaliseSuccessKind(undefined)).toBeNull();
    expect(normaliseSuccessKind(42)).toBeNull();
  });

  it("makes the decision layer stop at the finding when the objective says so", () => {
    const decision = decideAction(candidate(), mission({
      intent: "find_customer",
      objective: { kind: "find_candidates", targetCount: 10 },
    }));
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("result_only");
    expect(decision.reason).toBe("objective_collects_candidates");
    expect(decision.nextStage).toBe("complete");
  });

  it("makes the decision layer act when a finding-shaped mission asks to be contacted", () => {
    const decision = decideAction(candidate(), mission({
      intent: "find_solution",
      objective: { kind: "contact_and_wait", targetCount: 1 },
    }));
    expect(decision.decision).toBe("send_email");
    expect(decision.capability).toBe("send_email");
  });

  it("does not offer research it cannot perform", () => {
    const decision = decideAction(
      candidate({ routeKind: null, routeVerified: false }),
      mission({ researchConfigured: false }),
    );
    // With no way to look deeper, the honest answer is "blocked", not a
    // research loop the deployment cannot run.
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("blocked");
    expect(decision.reason).toBe("no_reachable_route");
    // And the trace says why investigating was rejected, derived from the same
    // inputs rather than reconstructed afterwards.
    expect(decision.alternatives.find((row) => row.decision === "investigate")?.reason)
      .toContain("research provider");
  });
});

// ── 2. The capability registry is the single source ───────────────────

function runtime(overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return { hasInbox: true, hasScrapableTarget: true, budgetAllowed: true, researchConfigured: true, ...overrides };
}

describe("the capability registry drives what is offered", () => {
  it("never offers something the product does not implement", () => {
    const states = resolveCapabilities(runtime());
    for (const key of ["schedule_meeting", "linkedin_message", "sms"]) {
      const state = states.find((entry) => entry.key === key);
      expect(state?.implemented).toBe(false);
      expect(state?.available).toBe(false);
      expect(state?.unavailableReason).toBe("Radar cannot do this yet.");
    }
  });

  it("reports email as unavailable without a sending inbox, and says why", () => {
    const email = resolveCapabilities(runtime({ hasInbox: false })).find((entry) => entry.key === "send_email");
    expect(email?.implemented).toBe(true);
    expect(email?.available).toBe(false);
    expect(email?.unavailableReason).toContain("inbox");
    // One missing requirement does not disable unrelated capabilities.
    const form = resolveCapabilities(runtime({ hasInbox: false })).find((entry) => entry.key === "submit_form");
    expect(form?.available).toBe(true);
  });

  it("reports research as unavailable when there is nothing to read or no provider", () => {
    const noTarget = resolveCapabilities(runtime({ hasScrapableTarget: false })).find((entry) => entry.key === "submit_form");
    expect(noTarget?.available).toBe(false);
    const noProvider = resolveCapabilities(runtime({ researchConfigured: false })).find((entry) => entry.key === "investigate");
    expect(noProvider?.available).toBe(false);
    expect(noProvider?.unavailableReason).toContain("research provider");
  });

  it("reports investigation as unavailable when the credits are gone", () => {
    const investigate = resolveCapabilities(runtime({ budgetAllowed: false })).find((entry) => entry.key === "investigate");
    expect(investigate?.available).toBe(false);
    expect(investigate?.unavailableReason).toContain("budget");
  });

  it("the UI query resolves the same registry against live workspace state", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, { intent: "find_customer" });

    const withoutInbox = await t.query(internal.capabilities.list, { workspaceId: WORKSPACE });
    const emailBefore = withoutInbox.find((entry) => entry.key === "send_email");
    expect(emailBefore?.available).toBe(false);
    // No sources yet, so there is no page a form could be on.
    expect(withoutInbox.find((entry) => entry.key === "submit_form")?.available).toBe(false);

    await addInbox(t);
    const withInbox = await t.query(internal.capabilities.list, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(withInbox.find((entry) => entry.key === "send_email")?.available).toBe(true);
  });

  it("the same registry decides the agent's own behaviour", async () => {
    // The decision layer is not allowed a private opinion about what exists:
    // with the same runtime facts, it reaches the same conclusion the UI shows.
    const states = resolveCapabilities(runtime({ hasInbox: false }));
    const emailAvailable = states.find((entry) => entry.key === "send_email")?.available;
    const decision = decideAction(candidate(), mission({ hasInbox: false, objective: null }));
    expect(emailAvailable).toBe(false);
    expect(decision.decision).toBe("no_action");
    expect(decision.reason).toBe("no_inbox");
  });
});

// ── 3. The objective drives the durable mission loop ──────────────────

describe("completion is measured against the plan's objective", () => {
  it("completes a contact-shaped intent that asked for candidates, with nothing sent", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, {
      intent: "find_customer",
      objective: { successKind: "find_candidates", targetCount: 2 },
    });
    await addMatch(t, missionId, "stronger");
    await addMatch(t, missionId, "promising");

    const completed = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(completed).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("actionDrafts").collect())).toHaveLength(0);
  });

  it("does not complete the candidate hunt until the requested number exists", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, {
      intent: "find_customer",
      objective: { successKind: "find_candidates", targetCount: 2 },
    });
    await addMatch(t, missionId, "stronger");
    expect(await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }))).toBe(false);
  });

  it("will not call a finding-mission finished just because a match exists", async () => {
    const t = convexTest(schema, convexModules);
    // find_business defaults to collecting candidates, but this user asked to
    // be put in touch, so the match alone is not the deliverable.
    const { missionId } = await seedMission(t, {
      intent: "find_business",
      objective: { successKind: "contact_and_wait", targetCount: 1 },
    });
    await addMatch(t, missionId, "stronger");
    expect(await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }))).toBe(false);
  });

  it("counts executed actions against the requested number", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, {
      intent: "find_business",
      objective: { successKind: "contact_and_wait", targetCount: 2 },
    });
    await addMatch(t, missionId, "stronger");
    const approval = await seedApprovedDraft(t, { artifactIds: [], authorized: true });
    await t.run(async (ctx) => {
      await ctx.db.patch(approval.actionId, { missionId: missionId as never, status: "sent" as const });
    });
    expect(await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }))).toBe(false);

    const second = await seedApprovedDraft(t, { artifactIds: [], authorized: true });
    await t.run(async (ctx) => {
      await ctx.db.patch(second.actionId, { missionId: missionId as never, status: "sent" as const });
    });
    expect(await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }))).toBe(true);
  });

  it("the user can set the objective and the loop obeys it immediately", async () => {
    const t = convexTest(schema, convexModules);
    // A plan exists but states no objective, so the intent's default (contact)
    // is in force and a match alone is not a finish.
    const { missionId } = await seedMission(t, { intent: "find_customer", objective: null });
    await addMatch(t, missionId, "stronger");
    expect(await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }))).toBe(false);

    const result = await t.mutation(internal.plans.setObjective, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      successKind: "find_candidates" as never,
      targetCount: 1,
    });
    expect(result.targetCount).toBe(1);
    const objective = await t.query(internal.plans.objectiveFor, { missionId: missionId as never });
    expect(objective).toEqual({ successKind: "find_candidates", targetCount: 1 });
    // Setting the objective re-checks completion itself, so the mission finishes
    // as a consequence of the decision rather than of a second click.
    const mission = await t.run((ctx) => ctx.db.get(missionId as never));
    expect((mission as { status: string }).status).toBe("complete");
  });

  it("an objective the user set survives a re-plan", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, {
      intent: "find_customer",
      objective: { successKind: "contact_and_wait", targetCount: 1 },
    });
    await t.mutation(internal.plans.setObjective, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      successKind: "find_candidates" as never,
      targetCount: 7,
    });
    // The planner runs again and proposes its own objective.
    await t.run((ctx) => ctx.runMutation(internal.plans.save, {
      missionId: missionId as never,
      normalizedGoal: "replanned",
      mode: "customer" as never,
      successKind: "contact_and_wait" as never,
      targetCount: 1,
      mustHave: [], niceToHave: [], exclusions: [], missingFacts: [],
      recommendedSources: [], proposedSteps: [], completionPredicate: "p",
      provider: "openai" as never, model: "test-model",
    }));
    expect(await t.query(internal.plans.objectiveFor, { missionId: missionId as never }))
      .toEqual({ successKind: "find_candidates", targetCount: 7 });
  });

  it("refuses to set an objective on a mission in another workspace", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t, {
      intent: "find_customer",
      objective: { successKind: "contact_and_wait", targetCount: 1 },
    });
    await expect(t.mutation(internal.plans.setObjective, {
      workspaceId: OTHER_WORKSPACE,
      missionId: missionId as never,
      successKind: "find_candidates" as never,
      targetCount: 1,
    })).rejects.toThrow();
  });
});

// ── 4. Artifacts travel inside the approved action ────────────────────

describe("an approved action carries the documents it was approved with", () => {
  it("offers only authorized, relevant documents as attachments", async () => {
    const t = convexTest(schema, convexModules);
    const authorized = await addSource(t, { title: "Scheduling software overview", allowed: true });
    await addSource(t, { title: "Scheduling software overview (private)", allowed: false });
    await addSource(t, { title: "Tax return 2025", allowed: true, text: "Line items and deductions." });

    const found = await t.query(internal.dataSources.authorizedArtifactsFor, {
      workspaceId: WORKSPACE,
      goal: "Find US veterinary clinics that could use my scheduling software",
    });
    expect(found.map((row) => row.sourceId)).toEqual([authorized]);
  });

  it("authorization is a switch the user owns, scoped to their workspace", async () => {
    const t = convexTest(schema, convexModules);
    const sourceId = await addSource(t, { title: "Case study", allowed: false });
    const granted = await t.mutation(internal.dataSources.setRepresentationAllowed, {
      workspaceId: WORKSPACE,
      sourceId: sourceId as never,
      allowed: true,
    });
    expect(granted.representationAllowed).toBe(true);
    await expect(t.mutation(internal.dataSources.setRepresentationAllowed, {
      workspaceId: OTHER_WORKSPACE,
      sourceId: sourceId as never,
      allowed: true,
    })).rejects.toThrow();
  });

  it("binds the attachments into the approval hash", async () => {
    const base = await contentHash("jordan@clinic.test", "Subject", "Body", "send_email", []);
    const one = await contentHash("jordan@clinic.test", "Subject", "Body", "send_email", ["source_a"]);
    const two = await contentHash("jordan@clinic.test", "Subject", "Body", "send_email", ["source_b"]);
    expect(one).not.toBe(base);
    expect(one).not.toBe(two);
    // Order is not part of the binding; the set is.
    expect(await contentHash("jordan@clinic.test", "Subject", "Body", "send_email", ["source_b", "source_a"]))
      .toBe(await contentHash("jordan@clinic.test", "Subject", "Body", "send_email", ["source_a", "source_b"]));
  });

  it("sends the authorized document with the message it was approved with", async () => {
    const t = convexTest(schema, convexModules);
    const sourceId = await addSource(t, { title: "Clinic deployments.pdf", allowed: true, text: "Ten deployments." });
    await addInbox(t);
    const { actionId } = await seedApprovedDraft(t, { artifactIds: [sourceId as never], authorized: true });

    await t.mutation(internal.outreachStore.approve, {
      workspaceId: WORKSPACE,
      actionId: actionId as never,
    });
    await t.action(internal.outreach.send, { workspaceId: WORKSPACE, actionId: actionId as never });

    const sent = sentCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments?.[0].filename).toBe("Clinic deployments.pdf");
    expect(Buffer.from(sent[0].attachments?.[0].content ?? "", "base64").toString("utf8")).toBe("Ten deployments.");
  });

  it("fails the send closed if the authorization is withdrawn after approval", async () => {
    const t = convexTest(schema, convexModules);
    const sourceId = await addSource(t, { title: "Private notes.pdf", allowed: true });
    await addInbox(t);
    const { actionId } = await seedApprovedDraft(t, { artifactIds: [sourceId as never], authorized: true });
    await t.mutation(internal.outreachStore.approve, { workspaceId: WORKSPACE, actionId: actionId as never });

    // The user changes their mind after approving: what was approved no longer
    // exists, so sending it would be a different action than the one approved.
    await t.mutation(internal.dataSources.setRepresentationAllowed, {
      workspaceId: WORKSPACE,
      sourceId: sourceId as never,
      allowed: false,
    });

    await expect(t.action(internal.outreach.send, { workspaceId: WORKSPACE, actionId: actionId as never }))
      .rejects.toThrow(/ARTIFACT_UNAVAILABLE/);
    expect(sentCalls()).toHaveLength(0);
    const draft = await t.run((ctx) => ctx.db.get(actionId as never));
    expect((draft as { status: string }).status).not.toBe("sent");
  });

  it("shows the attachments on the card the user approves", async () => {
    const t = convexTest(schema, convexModules);
    const sourceId = await addSource(t, { title: "Portfolio.pdf", allowed: true });
    const { missionId, actionId } = await seedApprovedDraft(t, { artifactIds: [sourceId as never], authorized: true });

    const drafts = await t.query(internal.outreachStore.listDrafts, { workspaceId: WORKSPACE, missionId: missionId as never });
    const view = drafts.find((draft) => draft._id === actionId);
    expect(view?.attachments).toEqual([{ sourceId, title: "Portfolio.pdf" }]);
  });
});

// ── Local fixtures ────────────────────────────────────────────────────

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    matchId: "m1",
    subject: "Acme Veterinary",
    label: "stronger",
    routeKind: "email",
    routeVerified: true,
    formBlocked: false,
    alreadyActioned: false,
    investigateUrl: "https://acme.test",
    evidenceCount: 3,
    evidence: ["Needs scheduling software"],
    ...overrides,
  };
}

function mission(overrides: Partial<MissionInput> = {}): MissionInput {
  return {
    intent: "find_customer",
    hasInbox: true,
    investigationsUsed: 0,
    budgetAllowed: true,
    objective: null,
    ...overrides,
  };
}
