import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { CREDIT_COST, estimateCrawl, estimateExtraction, estimateMission, estimateSearch } from "../convex/budget";
import { MAX_STAGE_RETRIES, retryDelayMs, shouldRetry } from "../convex/retryPolicy";
import { classifyProviderError } from "../convex/providerErrors";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

/**
 * A successful Firecrawl component, so the budget and load tests can drive real
 * discovery instead of hitting the network. The client is constructed at module
 * load in research.ts, so the mock must exist before the glob imports run.
 */
type SearchResponse = { web: Array<Record<string, unknown>> };
let searchImpl: (query: string, options?: unknown) => Promise<SearchResponse> = async () => ({ web: [] });
let searchCalls = 0;
vi.mock("@firecrawl/firecrawl-convex", () => {
  class FirecrawlClient {
    constructor(_component: unknown) {}
    async search(_ctx: unknown, query: string, options?: unknown) {
      searchCalls += 1;
      return searchImpl(query, options);
    }
    async scrape() {
      return { markdown: "# ok", metadata: { title: "ok" } };
    }
    async map() {
      return { links: [] };
    }
    async startCrawl() {
      return { crawlId: "crawl_test", jobId: "job_test" };
    }
  }
  return { FirecrawlClient };
});

function oneResult(markdown = "Acme builds climate analytics dashboards.") {
  return {
    web: [
      {
        url: "https://acme.example.com/careers",
        title: "Acme is hiring",
        description: "Acme needs a frontend partner.",
        markdown,
      },
    ],
  };
}

/** Seeds a mission plus a plan and a search backlog of `count` queries. */
async function seedMissionWithBacklog(t: TestT, count: number) {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Find companies that need React development.",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists for at least one sourced match.",
    });
    const now = Date.now();
    await ctx.db.insert("missionPlans", {
      missionId,
      normalizedGoal: "Find companies that need React development.",
      mode: "opportunity" as const,
      mustHave: ["needs React work"], niceToHave: [], exclusions: [], missingFacts: [],
      recommendedSources: [], proposedSteps: ["search"],
      completionPredicate: "A user-approved next action exists for at least one sourced match.",
      provider: "openai" as const, model: "test", createdAt: now,
    });
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("missionQueries", {
        missionId, query: `query number ${index}`, kind: "search" as const,
        status: "pending" as const, resultCount: null, createdAt: now + index,
      });
    }
    return missionId as unknown as string;
  });
}

async function forceStage(t: TestT, missionId: string, stage: string, status: string) {
  await t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (run) await ctx.db.patch(run._id, { currentStage: stage as never, status: status as never });
  });
}

async function getRun(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    return run ? { status: run.status, currentStage: run.currentStage, retryCount: run.retryCount, interruption: run.activeInterruption } : null;
  });
}

async function stepsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (!run) return [];
    const steps = await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect();
    return steps.map((step) => ({ label: step.label, tool: step.tool ?? null, errorCode: step.errorCode ?? null, summary: step.summary }));
  });
}

async function jobCount(t: TestT, missionId: string) {
  return t.run(async (ctx) => (await ctx.db.query("researchJobs").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect()).length);
}

async function doneQueries(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("missionQueries").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect();
    return rows.filter((row) => row.status === "done").length;
  });
}

/**
 * Drives the orchestrator until the run is no longer advanceable (or a bound is
 * hit). Discovery costs two invocations per query by design: the search job's
 * completion advances the run to `evaluate`, and the evaluate stage loops back
 * to `discover` while the backlog still has entries.
 */
async function drive(t: TestT, missionId: string, iterations: number) {
  for (let index = 0; index < iterations; index += 1) {
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
  }
  return await getRun(t, missionId);
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  searchCalls = 0;
  searchImpl = async () => ({ web: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe("provider credit budget", () => {
  it("estimates search, crawl, extraction, and whole-mission cost from the cost model", () => {
    expect(estimateSearch(6)).toBe(6 * CREDIT_COST.searchPerResult);
    expect(estimateCrawl(25)).toBe(25 * CREDIT_COST.crawlPerPage);
    expect(estimateExtraction(6)).toBe(6 * CREDIT_COST.extract);
    // Two searches + one crawl + three extractions.
    expect(estimateMission({ pendingSearches: 2, pendingCrawls: 1, resolvableSources: 3 }))
      .toBe(estimateSearch(6) * 2 + estimateCrawl(25) + estimateExtraction(3));
    // Never zero: an estimate of nothing would bypass the gate.
    expect(estimateSearch(0)).toBeGreaterThan(0);
  });

  it("bounds a user-set cap so a typo cannot disable the guard", async () => {
    const t = convexTest(schema, convexModules);
    await expect(t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 1 })).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 10_000_000 })).rejects.toThrow(/INVALID_ARGUMENT/);
    const set = await t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 250 });
    expect(set.creditLimit).toBe(250);
    const status = await t.query(api.budget.status, { workspaceId: WORKSPACE, missionId: null });
    expect(status.creditLimit).toBe(250);
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(250);
  });

  it("charges real spend through the ledger and reports it in status", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 1);
    await forceStage(t, missionId, "discover", "active");

    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });

    const charges = await t.query(api.budget.chargesForMission, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(charges).toHaveLength(1);
    expect(charges[0].kind).toBe("search");
    expect(charges[0].amount).toBe(estimateSearch(6));

    const status = await t.query(api.budget.status, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(status.used).toBe(estimateSearch(6));
    expect(status.breakdown.search).toBe(estimateSearch(6));
    expect(status.remaining).toBe(status.creditLimit - status.used);
  });

  it("parks the run as a budget block — not a failure — when the cap is too small", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 2);
    // Two searches at 6 credits each; 10 credits covers exactly one.
    await t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 10 });
    await forceStage(t, missionId, "discover", "active");

    // First query fits.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    expect(await jobCount(t, missionId)).toBe(1);

    // The second query does not fit, so the run parks instead of calling the
    // provider. Drive a few stages: discovery legitimately bounces through
    // evaluate between queries.
    const run = await drive(t, missionId, 6);
    expect(run?.status).toBe("blocked");
    expect(run?.currentStage).toBe("discover");
    expect(run?.interruption).toBe("budget_blocked");
    expect(await jobCount(t, missionId)).toBe(1);

    const steps = await stepsFor(t, missionId);
    const blocked = steps.find((step) => step.label === "budget.blocked");
    expect(blocked).toBeTruthy();
    expect(blocked!.tool).toBe("budget");
    expect(blocked!.errorCode).toBe("FIRECRAWL_CREDITS_EXHAUSTED");
    // It explains the spend decision and what to do next, not just an error.
    expect(blocked!.summary).toMatch(/credits/);
    expect(blocked!.summary).toMatch(/retry the stage/i);
    // The run keeps its place: no failure label was recorded for the stage.
    expect(steps.some((step) => step.label === "stage.discover.failed")).toBe(false);
  });

  it("resumes the same stage once the cap is raised", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 2);
    await t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 10 });
    await forceStage(t, missionId, "discover", "active");
    expect((await drive(t, missionId, 6))?.status).toBe("blocked");
    expect(await doneQueries(t, missionId)).toBe(1);

    // Raise the cap, then use the ordinary retry control — no special path.
    await t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 400 });
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.retryStage, { workspaceId: WORKSPACE, missionId: missionId as never }));
    const resumed = await getRun(t, missionId);
    expect(resumed?.status).toBe("active");
    expect(resumed?.currentStage).toBe("discover");
    expect(resumed?.interruption).toBeNull();

    await drive(t, missionId, 6);
    expect(await doneQueries(t, missionId)).toBe(2);
    expect(await jobCount(t, missionId)).toBe(2);
  });

  it("is idempotent per provider reference: a retried search never double-charges", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 1);
    await forceStage(t, missionId, "discover", "active");
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });

    const charges = await t.query(api.budget.chargesForMission, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(charges).toHaveLength(1);
    expect(charges[0].kind).toBe("search");

    // Replaying the provider reference the orchestrator already used is a no-op.
    const replay = await t.run((ctx) => ctx.runMutation(internal.budget.charge, {
      workspaceId: WORKSPACE, missionId: missionId as never, kind: "search" as const,
      amount: estimateSearch(6), reference: charges[0].reference,
    }));
    expect(replay.charged).toBe(false);

    // Genuinely new work still charges.
    const fresh = await t.run((ctx) => ctx.runMutation(internal.budget.charge, {
      workspaceId: WORKSPACE, missionId: missionId as never, kind: "crawl" as const,
      amount: estimateCrawl(25), reference: "crawl:different",
    }));
    expect(fresh.charged).toBe(true);

    const after = await t.query(api.budget.chargesForMission, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(after).toHaveLength(2);
  });

  it("reports an exhausted workspace as a spend decision, not an error", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 2);
    await t.mutation(api.budget.setLimit, { workspaceId: WORKSPACE, creditLimit: 10 });
    await t.run((ctx) => ctx.runMutation(internal.budget.charge, {
      workspaceId: WORKSPACE, missionId: missionId as never, kind: "crawl" as const,
      amount: 10, reference: "crawl:exhaust",
    }));

    const status = await t.query(api.budget.status, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(status.used).toBe(10);
    expect(status.remaining).toBe(0);
    expect(status.exhausted).toBe(true);
    // Two pending searches are estimated, so the run is not allowed to start.
    expect(status.pendingEstimate).toBeGreaterThan(0);
    expect(status.allowed).toBe(false);
    expect(status.breakdown.crawl).toBe(10);
  });
});

describe("centralized retry policy", () => {
  it("never retries a non-retryable classification, whatever the attempt count", () => {
    const credits = classifyProviderError("Insufficient credits to perform this request (402).");
    const refusal = classifyProviderError("The model refused on content_policy grounds.");
    const webhook = classifyProviderError("webhook signature invalid (svix)");
    for (const classified of [credits, refusal, webhook]) {
      expect(classified.retryable).toBe(false);
      for (let attempts = 0; attempts <= MAX_STAGE_RETRIES + 3; attempts += 1) {
        expect(shouldRetry(classified, attempts)).toBe(false);
      }
    }
  });

  it("retries retryable classes inside the budget only", () => {
    const rateLimited = classifyProviderError("429 too many requests");
    expect(rateLimited.retryable).toBe(true);
    expect(shouldRetry(rateLimited, 0)).toBe(true);
    expect(shouldRetry(rateLimited, MAX_STAGE_RETRIES - 1)).toBe(true);
    expect(shouldRetry(rateLimited, MAX_STAGE_RETRIES)).toBe(false);
  });

  it("backs off exponentially with a ceiling, and waits longer on a rate limit", () => {
    const rateLimited = classifyProviderError("429 too many requests");
    const unavailable = classifyProviderError("404 not found");

    expect(retryDelayMs(unavailable, 1)).toBeLessThan(retryDelayMs(unavailable, 2));
    expect(retryDelayMs(rateLimited, 1)).toBeGreaterThan(retryDelayMs(unavailable, 1));
    // Never unbounded: a provider outage cannot push a retry into next week.
    expect(retryDelayMs(unavailable, 20)).toBeLessThanOrEqual(10 * 60_000);
  });

  it("does not schedule a retry for a policy refusal, and does for a rate limit", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 0);
    await forceStage(t, missionId, "intake", "active");

    // A refusal from the model: non-retryable, so the retry budget is untouched.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "content_policy violation" } }), { status: 400 })));
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    let run = await getRun(t, missionId);
    expect(run?.status).toBe("blocked");
    expect(run?.retryCount).toBe(0);
    let steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.errorCode === "OPENAI_REFUSAL")).toBe(true);

    // A rate limit is retryable, so the attempt is consumed exactly once.
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "429 rate limit exceeded" } }), { status: 429 })));
    const secondMission = await seedMissionWithBacklog(t, 0);
    await forceStage(t, secondMission, "intake", "active");
    await t.action(internal.missionOrchestrator.runStage, { missionId: secondMission as never });
    run = await getRun(t, secondMission);
    expect(run?.status).toBe("blocked");
    expect(run?.retryCount).toBe(1);
    steps = await stepsFor(t, secondMission);
    expect(steps.some((step) => step.errorCode === "FIRECRAWL_RATE_LIMITED")).toBe(true);
  });
});

describe("idempotency sweep", () => {
  /**
   * The other three external writes are already locked down elsewhere — the
   * AgentMail webhook by event id (`tests/trust.test.ts`), the approved send by
   * content hash + client request id, and the form submission by its approval
   * (`tests/forms.test.ts`). Crawl page ingest was the remaining one.
   */
  it("re-delivering crawl completion never duplicates a page or re-opens a finished job", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, jobId } = await t.run(async (ctx) => {
      const { missionId } = await ctx.runMutation(api.missions.create, {
        workspaceId: WORKSPACE, title: "Crawl idempotency", rawGoal: "Crawl idempotency",
        constraints: [], sourceScope: "public-web", completionPredicate: "p",
      });
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).first();
      const now = Date.now();
      const jobId = await ctx.db.insert("researchJobs", {
        missionId, runId: run!._id, requestId: "crawl-req", operation: "crawl", query: "https://acme.example.com",
        status: "running", provider: "firecrawl", providerRequestId: null, crawlId: "crawl_1", crawlStatus: "scraping",
        errorCode: null, resultCount: 0, errorSummary: null, createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
      });
      // A live crawl has the run parked in `wait`, which is where its completion
      // callback wakes it from (wait → evaluate is the legal edge).
      await ctx.db.patch(run!._id, { currentStage: "wait" as const, status: "waiting" as const });
      return { missionId, jobId };
    });

    const pages = [
      { url: "https://acme.example.com/a", title: "A", content: "page a", truncated: false },
      { url: "https://acme.example.com/b", title: "B", content: "page b", truncated: false },
    ];
    const args = { jobId, missionId, crawlId: "crawl_1", crawlStatus: "completed" as const, pageCount: 2, error: null, pages };

    const first = await t.run((ctx) => ctx.runMutation(internal.researchStore.completeCrawlJob, args));
    expect(first.resultCount).toBe(2);

    // The same completion delivered again (a retried callback, a replayed
    // webhook) is a no-op: the job is already complete.
    const replay = await t.run((ctx) => ctx.runMutation(internal.researchStore.completeCrawlJob, args));
    expect(replay.resultCount).toBe(2);

    const sources = await t.run(async (ctx) => await ctx.db.query("sourceRecords").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((source) => source.url)).size).toBe(2);
    const discoveries = await t.run(async (ctx) => await ctx.db.query("discoveries").collect());
    expect(discoveries).toHaveLength(2);

    // A partial re-delivery (one page) also cannot duplicate the existing row.
    await t.run((ctx) => ctx.runMutation(internal.researchStore.completeCrawlJob, { ...args, pageCount: 1, pages: [pages[0]] }));
    const after = await t.run(async (ctx) => await ctx.db.query("sourceRecords").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(after).toHaveLength(2);
  });
});

describe("untrusted-content bounding", () => {
  it("never echoes raw provider payloads into a user-facing classification", () => {
    const secret = "sk-live-abcdef0123456789";
    const classified = classifyProviderError(`Payment required for key ${secret} — plan limit reached.`);
    expect(classified.code).toBe("FIRECRAWL_CREDITS_EXHAUSTED");
    expect(classified.summary).not.toContain(secret);
    expect(classified.nextAction).not.toContain(secret);
  });

  it("bounds provider page content before it is persisted as evidence", async () => {
    // A hostile page tries to bloat the record; the normalization must clamp it.
    searchImpl = async () => oneResult("x".repeat(500_000));
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 1);
    await forceStage(t, missionId, "discover", "active");
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });

    const sources = await t.run(async (ctx) => await ctx.db.query("sourceRecords").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
    expect(sources).toHaveLength(1);
    expect((sources[0].content ?? "").length).toBeLessThanOrEqual(12_000);
    expect(sources[0].excerpt.length).toBeLessThanOrEqual(500);
    expect(sources[0].title.length).toBeLessThanOrEqual(180);
  });
});

describe("load sanity", () => {
  it("drains a 20-query backlog one query per invocation without scheduler pileup", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 20);
    await forceStage(t, missionId, "discover", "active");

    // Forty invocations, exactly as the scheduler would deliver them (two per
    // query, because a completed search advances the run and evaluate loops back).
    await drive(t, missionId, 40);

    expect(await doneQueries(t, missionId)).toBe(20);
    // Exactly one provider call per query: the backlog is consumed in order and
    // no invocation ever fans out into more than one call.
    expect(await jobCount(t, missionId)).toBe(20);
    expect(searchCalls).toBe(20);

    // Past the end of the backlog no further provider work happens, however many
    // stale invocations arrive: discovery cannot re-run a consumed query.
    await drive(t, missionId, 10);
    expect(await jobCount(t, missionId)).toBe(20);
    expect(searchCalls).toBe(20);
  });

  it("a stale invocation on a non-advanceable run performs no provider call and schedules nothing", async () => {
    searchImpl = async () => oneResult();
    const t = convexTest(schema, convexModules);
    const missionId = await seedMissionWithBacklog(t, 20);
    await forceStage(t, missionId, "discover", "waiting");

    for (let index = 0; index < 5; index += 1) {
      await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    }

    expect(searchCalls).toBe(0);
    expect(await jobCount(t, missionId)).toBe(0);
    expect((await getRun(t, missionId))?.currentStage).toBe("discover");
    expect((await getRun(t, missionId))?.status).toBe("waiting");
  });
});
