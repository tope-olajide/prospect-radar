/**
 * Phase 4 — autonomous action intelligence.
 *
 * The question this suite answers is: "given this mission, this candidate, the
 * evidence behind it, the user's authorized context and what Radar can actually
 * execute, what should Radar do next?"
 *
 * It is in three parts on purpose:
 *
 *   1. `decideAction` — a pure function, so the whole decision matrix is
 *      asserted directly without a database, including the cases that must
 *      never act (scenario F) and the ones where acting is wrong (scenario G).
 *   2. `ungroundedClaims` — the representation boundary. Source-backed evidence
 *      may inform reasoning; it must never appear as something the user said.
 *   3. `decideForMission` — the durable path, so the decisions are proven to
 *      reach real drafts, real blocked states and real mission completion.
 *
 * Scenarios A–G are the product requirements from the Phase 4 directive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  MAX_INVESTIGATIONS,
  decideAction,
  policyForIntent,
  successPolicyFor,
  type CandidateInput,
  type MissionInput,
} from "../convex/actionDecision";
import { ungroundedClaims } from "../convex/claimGuard";

const convexModules = import.meta.glob("../convex/**/*.*s");
type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

vi.mock("@agentmail/convex", () => {
  class AgentMail {
    constructor(_component: unknown) {}
    async sendMessage() { return "out_1"; }
    async replyToMessage() { return "out_1"; }
    async status() { return { status: "sent", agentmailMessageId: "msg_1", threadId: "thread_1" }; }
  }
  return { AgentMail, verifyAgentMailWebhook: () => ({}) };
});

// ── Part 1: the decision matrix ────────────────────────────────────────

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    matchId: "m1",
    subject: "Acme",
    label: "stronger",
    routeKind: "email",
    routeVerified: true,
    formBlocked: false,
    alreadyActioned: false,
    investigateUrl: "https://acme.test",
    evidenceCount: 3,
    ...overrides,
  };
}

function mission(overrides: Partial<MissionInput> = {}): MissionInput {
  return {
    intent: "find_customer",
    hasInbox: true,
    investigationsUsed: 0,
    budgetAllowed: true,
    // No stated objective means the intent's default stands, which is what the
    // cases below are about; the objective's own precedence is asserted in
    // `objectivePolicy.test.ts`.
    objective: null,
    ...overrides,
  };
}

describe("decideAction — match quality is not actionability", () => {
  it("A: a strong match with a verified address is proposed as email", () => {
    const decision = decideAction(candidate(), mission());
    expect(decision.decision).toBe("send_email");
    expect(decision.actionability).toBe("ready");
    expect(decision.reason).toBe("verified_email_route");
  });

  it("A: a strong match with no sending inbox is blocked, not silently re-routed", () => {
    const decision = decideAction(candidate(), mission({ hasInbox: false }));
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("blocked");
    // The route is known and fine — research cannot fix a missing inbox, so
    // Radar does not go looking for one.
    expect(decision.reason).toBe("no_inbox");
  });

  it("B: a strong match with no route and investigation spent is blocked, never guessed", () => {
    const decision = decideAction(
      candidate({ routeKind: null, routeVerified: false, label: "stronger" }),
      mission({ investigationsUsed: MAX_INVESTIGATIONS }),
    );
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("blocked");
    expect(decision.reason).toBe("no_reachable_route");
    // Nothing about a recipient is invented anywhere in the decision.
    expect(decision.targetUrl).toBeNull();
  });

  it("B: a strong match with no route investigates once instead of giving up or guessing", () => {
    const decision = decideAction(
      candidate({ routeKind: null, routeVerified: false }),
      mission(),
    );
    expect(decision.decision).toBe("investigate");
    expect(decision.reason).toBe("route_unknown");
    expect(decision.targetUrl).toBe("https://acme.test");
  });

  it("C: a vague match on thin evidence investigates rather than emailing on a hunch", () => {
    const decision = decideAction(
      candidate({ label: "uncertain", evidenceCount: 1 }),
      mission(),
    );
    expect(decision.decision).toBe("investigate");
    expect(decision.actionability).toBe("investigate");
    expect(decision.reason).toBe("evidence_insufficient");
  });

  it("C: investigating stops when the mission has spent its investigations", () => {
    const decision = decideAction(
      candidate({ label: "uncertain", evidenceCount: 1 }),
      mission({ investigationsUsed: MAX_INVESTIGATIONS }),
    );
    expect(decision.decision).not.toBe("investigate");
    // It still has a usable route, so it falls through to acting on what it has.
    expect(decision.decision).toBe("send_email");
  });

  it("C: investigating stops when the budget cannot afford it", () => {
    const decision = decideAction(
      candidate({ label: "uncertain", evidenceCount: 1 }),
      mission({ budgetAllowed: false }),
    );
    expect(decision.decision).not.toBe("investigate");
  });

  it("E: a form is the proposed route when that is the only way in", () => {
    const decision = decideAction(candidate({ routeKind: "form", routeVerified: true }), mission());
    expect(decision.decision).toBe("submit_form");
    expect(decision.actionability).toBe("ready");
    expect(decision.reason).toBe("public_form_route");
  });

  it("E: a form that cannot be submitted safely is blocked", () => {
    const decision = decideAction(
      candidate({ routeKind: "form", routeVerified: true, formBlocked: true }),
      mission({ investigationsUsed: MAX_INVESTIGATIONS }),
    );
    expect(decision.decision).toBe("no_action");
    expect(decision.reason).toBe("form_unusable");
  });

  it("F: evidence that contradicts the goal produces no action at all", () => {
    const decision = decideAction(candidate({ label: "insufficient" }), mission());
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("not_actionable");
    expect(decision.reason).toBe("insufficient_fit");
  });

  it("G: find_solution records the finding and contacts nobody", () => {
    const decision = decideAction(
      candidate({ label: "stronger" }),
      mission({ intent: "find_solution" }),
    );
    expect(decision.decision).toBe("no_action");
    expect(decision.actionability).toBe("result_only");
    expect(decision.reason).toBe("objective_presents_result");
  });

  it("G: find_business collects candidates without contacting them", () => {
    const decision = decideAction(candidate({ label: "promising" }), mission({ intent: "find_business" }));
    expect(decision.decision).toBe("no_action");
    expect(decision.reason).toBe("objective_collects_candidates");
  });

  it("refuses a route Radar has no capability for", () => {
    const decision = decideAction(
      candidate({ routeKind: "linkedin", routeVerified: true }),
      mission({ investigationsUsed: MAX_INVESTIGATIONS }),
    );
    expect(decision.decision).toBe("no_action");
    expect(decision.reason).toBe("unsupported_route");
  });

  it("does not prepare a second action for a counterpart that already has one", () => {
    const decision = decideAction(candidate({ alreadyActioned: true }), mission());
    expect(decision.decision).toBe("no_action");
    expect(decision.reason).toBe("already_actioned");
  });
});

describe("intent policy", () => {
  it("treats contact as required only for intents that are about reaching someone", () => {
    expect(policyForIntent("find_customer").contactRequired).toBe(true);
    expect(policyForIntent("find_solution").contactRequired).toBe(false);
    expect(policyForIntent("find_business").contactRequired).toBe(false);
  });

  it("gives research-shaped intents a completion target that is not one email", () => {
    expect(successPolicyFor("find_customer").kind).toBe("contact_and_wait");
    expect(successPolicyFor("find_solution")).toEqual({ kind: "present_solution", targetCount: 1 });
    expect(successPolicyFor("find_business")).toEqual({ kind: "find_candidates", targetCount: 3 });
  });

  it("falls back to the contact policy for an unknown intent", () => {
    expect(policyForIntent(undefined).contactRequired).toBe(true);
    expect(policyForIntent("opportunity").contactForRequired ?? true).toBe(true);
  });
});

// ── Part 2: the representation boundary ────────────────────────────────

describe("ungroundedClaims — what Radar may say in the user's name", () => {
  const sources = [{
    title: "Portfolio.pdf",
    text: "I have five years of React experience, specialising in fintech platforms and design systems.",
  }];

  it("D: flags a first-person claim that exists only in unconfirmed material", () => {
    const flagged = ungroundedClaims(
      "Hi — I have five years of React experience and would love to help with this.",
      { authorizedFacts: [{ category: "skills", value: "Frontend development" }], reasoningSources: sources },
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("five years");
  });

  it("D: allows the same claim once the user has confirmed it", () => {
    const flagged = ungroundedClaims(
      "Hi — I have five years of React experience and would love to help with this.",
      {
        authorizedFacts: [
          { category: "skills", value: "React" },
          { category: "experience", value: "five years of React experience" },
        ],
        reasoningSources: sources,
      },
    );
    expect(flagged).toEqual([]);
  });

  it("never flags a statement about the recipient repeating their own page", () => {
    const flagged = ungroundedClaims(
      "I noticed your team is hiring React engineers for the fintech platform, and I wanted to ask about the timeline.",
      { authorizedFacts: [], reasoningSources: sources },
    );
    expect(flagged).toEqual([]);
  });

  it("flags nothing when there is no unconfirmed material to draw on", () => {
    const flagged = ungroundedClaims("I have ten years of Rust experience.", {
      authorizedFacts: [{ category: "skills", value: "Rust" }],
      reasoningSources: [],
    });
    expect(flagged).toEqual([]);
  });
});

// ── Part 3: the durable path ───────────────────────────────────────────

type SeedIntent = "find_opportunity" | "find_customer" | "find_solution" | "find_business";

/** Seeds a mission at the evaluation result: one match, one resolved entity. */
async function seedMissionWithMatch(
  t: TestT,
  opts: {
    intent: SeedIntent;
    label?: string;
    route?: { kind: "email" | "form" | "linkedin"; value: string } | null;
    inbox?: boolean;
    content?: string;
    investigationsUsed?: number;
    formBlocked?: boolean;
    canonicalUrl?: string | null;
  },
) {
  const now = Date.now();
  return t.run(async (ctx) => {
    const missionId = await ctx.db.insert("missions", {
      workspaceId: WORKSPACE,
      title: "Phase 4 seed",
      rawGoal: "Find customers for my product",
      mode: "customer" as const,
      intent: { primary: opts.intent, secondary: null, confidence: 0.9, rationale: "test" },
      targetEntity: "organization",
      relationshipGoal: "become_their_vendor",
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
    for (let i = 0; i < (opts.investigationsUsed ?? 0); i += 1) {
      await ctx.db.insert("runSteps", {
        missionId, runId, stage: "approval" as const, label: "action.investigate",
        summary: "looked deeper", reference: null, errorCode: null, tool: "firecrawl.crawl",
        createdAt: now,
      });
    }
    if (opts.inbox ?? true) {
      await ctx.db.insert("agentInboxes", {
        workspaceId: WORKSPACE, agentmailInboxId: "inbox_test", email: "radar@example.test",
        displayName: null, createdAt: now, updatedAt: now,
      });
    }
    const jobId = await ctx.db.insert("researchJobs", {
      missionId, runId, requestId: "req1", operation: "search", query: "q", status: "complete",
      provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null,
      errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now,
      finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId, jobId, url: "https://acme.test/contact", title: "Acme", sourceType: "search_result",
      excerpt: "e", content: opts.content ?? null, fetchedAt: now, freshness: "fresh",
      firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped",
      errorSummary: null, createdAt: now, updatedAt: now,
    });
    const discoveryId = await ctx.db.insert("discoveries", {
      missionId, sourceId, subject: "Acme", signal: "Needs help", publishedAt: null,
      extractedFields: [], createdAt: now, updatedAt: now,
    });
    const matchId = await ctx.db.insert("matches", {
      missionId, discoveryId, sourceId, label: (opts.label ?? "stronger") as never,
      positiveEvidence: ["Needs a frontend partner", "Recently funded"],
      unknowns: [], risks: [], freshness: "fresh", recommendedAction: "outreach",
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("entities", {
      workspaceId: WORKSPACE, missionId, sourceId, kind: "organization" as const, name: "Acme",
      nameLower: "acme", canonicalUrl: opts.canonicalUrl === undefined ? "https://acme.test" : (opts.canonicalUrl ?? ""),
      attributes: [], summary: "Acme builds things", skillsOrOffer: [],
      contactRoute: opts.route === undefined
        ? { kind: "email" as const, value: "jordan@acme.test", publicSource: "https://acme.test" }
        : opts.route === null
          ? undefined
          : { ...opts.route, publicSource: "https://acme.test" },
      extractionStatus: "extracted" as const, confidence: 0.9, firstSeenAt: now, updatedAt: now,
    });
    if (opts.formBlocked !== undefined) {
      await ctx.db.insert("formTemplates", {
        workspaceId: WORKSPACE, missionId, sourceId, url: "https://acme.test/apply",
        formTitle: "Apply", submitLabel: "Send", submitSelector: "#send",
        fields: opts.formBlocked ? [] : [{ name: "email", label: "Email", type: "email", required: true, selector: "#email" } as never],
        blockedReason: opts.formBlocked ? ("captcha" as never) : null, blockedDetail: "",
        confidence: 0.8, scoutedAt: now, createdAt: now, updatedAt: now,
      });
    }
    return { missionId, runId, matchId, sourceId };
  });
}

async function decisions(t: TestT, missionId: string) {
  return t.run((ctx) => ctx.runQuery(internal.actionStore.decisionsForMission, { missionId: missionId as never }));
}

function llmDraft(subject: string, body: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject, body }) } }] }), { status: 200 });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe("decideForMission — the decision reaches real action", () => {
  it("A: proposes an email for a strong, reachable match", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft(
      "Frontend partnership",
      "Hi Jordan — I saw Acme is growing. Would you be open to a short conversation? Reply to jordan@acme.test if you would rather not use this address.",
    )));
    const { missionId, matchId } = await seedMissionWithMatch(t, {
      intent: "find_customer",
      content: "Contact jordan@acme.test for partnerships. radar@example.test",
    });

    const result = await t.action(internal.actions.decideForMission, { missionId: missionId as never });

    expect(result.proposed).toBe(1);
    expect(result.investigating).toBe(0);
    const drafts = await t.run((ctx) => ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("draft");
    expect(drafts[0].matchId).toBe(matchId);
    expect(drafts[0].recipient).toBe("jordan@acme.test");
    const persisted = await decisions(t, missionId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      decision: "send_email",
      actionability: "ready",
      reason: "verified_email_route",
      quality: "stronger",
    });
  });

  it("B: drafts nothing when no route could be verified, and says why", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, {
      intent: "find_customer",
      route: null,
      // Investigation already spent, so the only honest answer is "blocked".
      investigationsUsed: MAX_INVESTIGATIONS,
    });

    const result = await t.action(internal.actions.decideForMission, { missionId: missionId as never });

    expect(result.proposed).toBe(0);
    expect(result.investigating).toBe(0);
    expect(result.topReason).toBe("no_reachable_route");
    const drafts = await t.run((ctx) => ctx.db.query("actionDrafts").collect());
    expect(drafts).toHaveLength(0);
    const persisted = await decisions(t, missionId);
    expect(persisted[0]).toMatchObject({ decision: "no_action", actionability: "blocked", reason: "no_reachable_route" });
  });

  it("A: with no inbox, the reason names the missing inbox rather than a missing match", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, { intent: "find_customer", inbox: false });

    const result = await t.action(internal.actions.decideForMission, { missionId: missionId as never });

    expect(result.proposed).toBe(0);
    expect(result.topReason).toBe("no_inbox");
    expect(result.blocked).toBe(1);
  });

  it("C: an investigation is queued as ordinary research work, not a special path", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, {
      intent: "find_customer",
      route: null,
      content: null,
    });

    const result = await t.action(internal.actions.decideForMission, { missionId: missionId as never });

    expect(result.investigating).toBe(1);
    expect(result.investigateUrl).toBe("https://acme.test");
    const pending = await t.run((ctx) => ctx.runQuery(internal.orchestratorStore.pendingQueries, { missionId: missionId as never }));
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("crawl");
    expect(pending[0].query).toBe("https://acme.test");
  });

  it("does not queue the same investigation twice", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, { intent: "find_customer", route: null });
    await t.action(internal.actions.decideForMission, { missionId: missionId as never });
    await t.action(internal.actions.decideForMission, { missionId: missionId as never });
    const pending = await t.run((ctx) => ctx.runQuery(internal.orchestratorStore.pendingQueries, { missionId: missionId as never }));
    expect(pending).toHaveLength(1);
  });

  it("E: proposes a form submission when the form is the only route", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ fieldValues: [{ name: "email", value: "radar@example.test", sourceFactId: null }] }) } }],
    }), { status: 200 })));
    const { missionId } = await seedMissionWithMatch(t, {
      intent: "find_customer",
      route: { kind: "form", value: "https://acme.test/apply" },
    });
    // A confirmed fact is required before Radar will fill anything.
    await t.run((ctx) => ctx.db.insert("contextFacts", {
      workspaceId: WORKSPACE, missionId: null, category: "skills", value: "Email: radar@example.test",
      sourceType: "user_input", sourceReference: null, confidence: 1,
      verificationStatus: "user_confirmed", visibility: "workspace",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));

    await t.action(internal.actions.decideForMission, { missionId: missionId as never });

    // The decision is the form route, not an email, and Radar genuinely tried
    // to act on it. Reading the live form needs Firecrawl, which is not reachable
    // from this suite, so the attempt is what is asserted here rather than the
    // prepared proposal — that path is covered by forms.test.ts.
    const persisted = await decisions(t, missionId);
    expect(persisted[0].decision).toBe("submit_form");
    expect(persisted[0].actionability).toBe("ready");
    const steps = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      if (!run) return [];
      return (await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect()).map((step) => step.label);
    });
    expect(steps.some((label) => label === "action.proposed" || label === "action.proposal_failed" || label === "action.blocked")).toBe(true);
  });

  it("G: find_solution completes on its finding without contacting the vendor", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, { intent: "find_solution", label: "stronger" });

    const result = await t.action(internal.actions.decideForMission, { missionId: missionId as never });
    expect(result.proposed).toBe(0);
    expect(result.resultOnly).toBe(1);

    const persisted = await decisions(t, missionId);
    expect(persisted[0]).toMatchObject({ decision: "no_action", actionability: "result_only" });

    // The mission's own success policy decides completion, not the absence of
    // an email: a solution found is the deliverable.
    const completed = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(completed).toBe(true);
    const drafts = await t.run((ctx) => ctx.db.query("actionDrafts").collect());
    expect(drafts).toHaveLength(0);
  });

  it("G: a contact-shaped mission is not completed by finding a match alone", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, { intent: "find_customer" });
    const completed = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(completed).toBe(false);
  });
});

describe("the action gate keeps the loop closed", () => {
  it("an investigate decision sends the mission back to research instead of parking", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, { intent: "find_customer", route: null });

    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });

    const run = await t.run((ctx) => ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first());
    expect(run?.currentStage).toBe("discover");
    expect(run?.status).toBe("active");
  });

  it("a blocked decision parks at the gate with the real reason", async () => {
    const t = convexTest(schema, convexModules);
    vi.stubGlobal("fetch", vi.fn(async () => llmDraft("x", "y")));
    const { missionId } = await seedMissionWithMatch(t, {
      intent: "find_customer",
      route: null,
      investigationsUsed: MAX_INVESTIGATIONS,
    });

    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });

    const run = await t.run((ctx) => ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first());
    expect(run?.currentStage).toBe("approval");
    expect(run?.status).toBe("waiting");
    const events = await t.run((ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    const awaiting = events.filter((event) => event.type === "approval.awaiting");
    expect(awaiting).toHaveLength(1);
    // The gate says what actually happened, not a generic apology.
    expect(awaiting[0].safeSummary).toContain("will not guess");
  });
});
