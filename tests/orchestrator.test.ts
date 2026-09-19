import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

function llmReply(body: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });
}

function stubFetch(responder: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async () => responder()));
}

/** Seeds a mission (real mutation) and returns its id. */
async function seedMission(t: TestT, rawGoal = "Find companies that need React development.") {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: rawGoal.slice(0, 80),
      rawGoal,
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists for at least one sourced match.",
    });
    return missionId as unknown as string;
  });
}

async function getRun(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    return run ? { status: run.status, currentStage: run.currentStage, retryCount: run.retryCount } : null;
  });
}

async function stepsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (!run) return [];
    const steps = await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect();
    return steps.map((s) => ({ label: s.label, tool: s.tool ?? null, stage: s.stage, errorCode: s.errorCode ?? null }));
  });
}

/** Forces the run into an arbitrary stage/status (test seam, bypasses transitions). */
async function forceStage(t: TestT, missionId: string, stage: string, status: string) {
  await t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (run) await ctx.db.patch(run._id, { currentStage: stage as never, status: status as never });
  });
}

/** Seeds a plan with a search backlog, as planMission's save would. */
async function seedBacklog(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("missionPlans", {
      missionId: missionId as never,
      normalizedGoal: "normalized",
      mode: "opportunity" as const,
      mustHave: [], niceToHave: [], exclusions: [], missingFacts: [],
      recommendedSources: [], proposedSteps: [],
      completionPredicate: "A user-approved next action exists for at least one sourced match.",
      provider: "openai" as const, model: "test", createdAt: now,
    });
    for (const query of ["companies hiring react developers", "startups asking for frontend help"]) {
      await ctx.db.insert("missionQueries", { missionId: missionId as never, query, kind: "search" as const, status: "pending" as const, resultCount: null, createdAt: now });
    }
    return null;
  });
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

describe("runPipeline / stopRun — user controls", () => {
  it("starts a queued mission; a non-queued run is not restarted", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    const started = await t.run((ctx) => ctx.runMutation(api.orchestratorStore.runPipeline, { workspaceId: WORKSPACE, missionId: missionId as never }));
    expect(started.started).toBe(true);
    // The run is still queued here because scheduled functions don't execute
    // inside t.run — runPipeline's guard is on run.status, so simulate an
    // advanced run to prove the second call is a no-op.
    await forceStage(t, missionId, "interpret", "active");
    const again = await t.run((ctx) => ctx.runMutation(api.orchestratorStore.runPipeline, { workspaceId: WORKSPACE, missionId: missionId as never }));
    expect(again.started).toBe(false);
    expect(again.stage).toBe("interpret");
  });

  it("rejects cross-workspace control", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await expect(t.run((ctx) => ctx.runMutation(api.orchestratorStore.runPipeline, { workspaceId: "attacker", missionId: missionId as never }))).rejects.toThrow("FORBIDDEN_SCOPE");
    await expect(t.run((ctx) => ctx.runMutation(api.orchestratorStore.stopRun, { workspaceId: "attacker", missionId: missionId as never }))).rejects.toThrow("FORBIDDEN_SCOPE");
    await expect(t.run((ctx) => ctx.runMutation(api.orchestratorStore.retryStage, { workspaceId: "attacker", missionId: missionId as never }))).rejects.toThrow("FORBIDDEN_SCOPE");
  });

  it("stop cancels an active run and scheduled stages become no-ops", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "active");
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.stopRun, { workspaceId: WORKSPACE, missionId: missionId as never }));
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("cancelled");
    // A stale scheduled stage invocation does nothing.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const after = await getRun(t, missionId);
    expect(after?.status).toBe("cancelled");
    const events = await t.run(async (ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(events.some((e) => e.type === "run.stopped")).toBe(true);
  });

  it("stop is refused on terminal runs without state change", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "complete", "complete");
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.stopRun, { workspaceId: WORKSPACE, missionId: missionId as never }));
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("complete");
  });
});

describe("runStage — stage dispatch", () => {
  it("intake: classifies intent then schedules the next stage", async () => {
    stubFetch(() => llmReply({ intent: { primary: "find_opportunity", secondary: null, confidence: 0.9, rationale: "r" }, targetEntity: "organization", relationshipGoal: "become_their_vendor", understanding: "You want companies needing React work.", clarificationNeeded: false, clarificationQuestion: null }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("interpret");
    const mission = await t.run(async (ctx) => ctx.db.get(missionId as never));
    expect(mission?.intent?.primary).toBe("find_opportunity");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((s) => s.tool === "llm.classify")).toBe(true);
  });

  it("interpret: plans and materializes the discovery backlog, then moves to discover", async () => {
    stubFetch(() => llmReply({ normalizedGoal: "Find companies needing React work.", mode: "opportunity", mustHave: ["need"], niceToHave: [], exclusions: [], missingFacts: [], recommendedSources: ["job boards"], proposedSteps: ["search"], completionPredicate: "one approved send", strategyNotes: "ok", searchQueries: ["companies hiring react", "startups needing frontend"], crawlTargets: ["https://example.com/careers"] }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "interpret", "active");
    // planMission reads intent via missionsInternal.get; seed a classified intent.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.missions.applyIntent, {
        missionId: missionId as never,
        intent: { primary: "find_opportunity", secondary: null, confidence: 0.9, rationale: "r" },
        targetEntity: "organization",
        relationshipGoal: "become_their_vendor",
        mode: "opportunity",
        clarification: null,
      });
      // Seed the facts find_opportunity requires, so context_check passes:
      // skills (category "skills") and engagement type (category "engagement").
      for (const [category, value] of [["skills", "React development"], ["engagement", "Contract work"]] as const) {
        await ctx.db.insert("contextFacts", {
          workspaceId: WORKSPACE,
          missionId: null,
          category,
          value,
          sourceType: "user_input",
          sourceReference: null,
          confidence: 1,
          verificationStatus: "user_confirmed",
          visibility: "workspace",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run1 = await getRun(t, missionId);
    // interpret → context_check: the orchestrator checks readiness before planning.
    expect(run1?.currentStage).toBe("context_check");
    // context_check runs automatically and, when ready, transitions to plan_review.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    // stageDone transitions context_check → plan_review; the orchestrator then
    // pauses in waiting so the user can review the plan before searching.
    expect(run?.currentStage).toBe("plan_review");
    expect(run?.status).toBe("waiting");
    const queries = await t.run(async (ctx) => ctx.db.query("missionQueries").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(queries.filter((q) => q.kind === "search")).toHaveLength(2);
    expect(queries.some((q) => q.kind === "crawl")).toBe(true);
    const plan = await t.run(async (ctx) => ctx.db.query("missionPlans").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first());
    expect(plan?.normalizedGoal).toBe("Find companies needing React work.");
  });

  it("discover: a provider refusal consumes its query and leaves the mission running", async () => {
    // First fetch call is the plan LLM, then Firecrawl search (module-level client hits network only via component mock).
    stubFetch(() => llmReply({ web: [] }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await seedBacklog(t, missionId);
    await forceStage(t, missionId, "discover", "active");
    // The Firecrawl component is not mocked here, so the search action fails on
    // the network call. One refused query is a missing source, not a dead
    // mission: the query is consumed with a classified reason and the run keeps
    // working through the rest of the backlog.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("discover");

    const steps = await stepsFor(t, missionId);
    const failed = steps.find((s) => s.label === "discover.query.failed");
    expect(failed).toBeTruthy();
    expect(failed!.tool).toBe("firecrawl.search");

    // Consumed, not retried: a skipped query can never produce a duplicate call.
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query("missionQueries").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect()).map((row) => row.status),
    );
    expect(statuses).toContain("skipped");
  });

  it("discover with an empty backlog advances to evaluate on its own", async () => {
    stubFetch(() => llmReply({ explanations: [] }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "active");
    // An empty backlog means discovery is finished. Evaluating what was found is
    // the agent's own work, so it moves on rather than parking for a human
    // "continue" — the user's next decision point is the action gate.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.currentStage).toBe("evaluate");
    expect(run?.status).toBe("active");
  });

  it("approval gate: opens the gate and waits — never advances", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "approval", "active");
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("waiting");
    expect(run?.currentStage).toBe("approval");
    // Another invocation stays parked (hard stop).
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const again = await getRun(t, missionId);
    expect(again?.status).toBe("waiting");
    const events = await t.run(async (ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(events.some((e) => e.type === "approval.awaiting")).toBe(true);
  });

  it("stale invocation on a waiting run is a no-op", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("waiting");
    expect(run?.currentStage).toBe("wait");
  });
});

describe("failure handling and retry", () => {
  it("classify failure blocks the run with a classified error code", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("blocked");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((s) => s.errorCode === "PROVIDER_ERROR")).toBe(true);
  });

  it("retryStage resumes a blocked run and refuses non-blocked runs", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    expect((await getRun(t, missionId))?.status).toBe("blocked");
    // Retry resumes at the blocked stage (intake); the scheduled invocation
    // doesn't execute inside t.run, so drive it manually with a working LLM.
    stubFetch(() => llmReply({ intent: { primary: "find_person", secondary: null, confidence: 0.8, rationale: "r" }, targetEntity: "person", relationshipGoal: "hire_or_contract", understanding: "u", clarificationNeeded: false, clarificationQuestion: null }));
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.retryStage, { workspaceId: WORKSPACE, missionId: missionId as never }));
    let run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("intake");
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    run = await getRun(t, missionId);
    expect(run?.currentStage).toBe("interpret");
    // Non-blocked runs are refused.
    await expect(t.run((ctx) => ctx.runMutation(api.orchestratorStore.retryStage, { workspaceId: WORKSPACE, missionId: missionId as never }))).rejects.toThrow("INVALID_STATE");
  });

  it("non-retryable failures (credit exhaustion) do not auto-retry but stay blocked for the user", async () => {
    stubFetch(() => new Response("Insufficient credits to perform this request (402).", { status: 402 }));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("blocked");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((s) => s.errorCode === "FIRECRAWL_CREDITS_EXHAUSTED")).toBe(true);
  });
});

describe("checkCompletion — the completion predicate", () => {
  it("does not complete without a sent action", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    const done = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(done).toBe(false);
  });

  it("completes the mission once a sourced match exists and a send is recorded", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const jobId = await ctx.db.insert("researchJobs", { missionId: missionId as never, runId: (await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first())!._id, requestId: "req1", operation: "search", query: "q", status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null, errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now });
      const sourceId = await ctx.db.insert("sourceRecords", { missionId: missionId as never, jobId: jobId, url: "https://example.com", title: "Example", sourceType: "search_result", excerpt: "e", content: null, fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now });
      const discoveryId = await ctx.db.insert("discoveries", { missionId: missionId as never, sourceId, subject: "Example", signal: "signal", publishedAt: null, extractedFields: [], createdAt: now, updatedAt: now });
      await ctx.db.insert("matches", { missionId: missionId as never, discoveryId, sourceId, label: "promising", positiveEvidence: ["e"], unknowns: [], risks: [], freshness: "fresh", recommendedAction: "outreach", createdAt: now, updatedAt: now });
      const inboxId = await ctx.db.insert("agentInboxes", { workspaceId: WORKSPACE, agentmailInboxId: "inbox_test", email: "agent@agentmail.test", displayName: null, createdAt: now, updatedAt: now });
      await ctx.db.insert("actionDrafts", { missionId: missionId as never, matchId: null, workspaceId: WORKSPACE, agentmailInboxId: inboxId, clientRequestId: "cr1", providerDraftId: null, recipient: "a@b.test", subject: "s", body: "b", contentHash: "0".repeat(64), capability: "send_email", status: "sent", outboundId: "out_1", providerMessageId: "msg_1", threadId: "thread_1", errorSummary: null, createdAt: now, updatedAt: now });
    });
    const done = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(done).toBe(true);
    const mission = await t.run(async (ctx) => ctx.db.get(missionId as never));
    expect(mission?.status).toBe("complete");
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("complete");
    const events = await t.run(async (ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(events.some((e) => e.type === "mission.complete")).toBe(true);
    // The mission is complete; re-checking is stable (no duplicate events).
    const eventsBefore = await t.run(async (ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    // A completed mission short-circuits: stable, no duplicate events.
    const again = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(again).toBe(false);
    const eventsAfter = await t.run(async (ctx) => ctx.db.query("runEvents").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(eventsAfter.filter((e) => e.type === "mission.complete")).toHaveLength(1);
    void eventsBefore;
  });

  it("never completes a cancelled run", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "cancelled");
    const done = await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.checkCompletion, { missionId: missionId as never }));
    expect(done).toBe(false);
  });
});
