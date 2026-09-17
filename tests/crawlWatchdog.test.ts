import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { CRAWL_WAIT_MS } from "../convex/crawlWatchdog";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

/**
 * The Firecrawl client is constructed at module load in research.ts, so the
 * mock has to exist before the glob imports run. These tests never reach the
 * provider — the watchdog only reads run state — but the module graph must load.
 */
vi.mock("@firecrawl/firecrawl-convex", () => {
  class FirecrawlClient {
    constructor(_component: unknown) {}
    async search() { return { web: [] }; }
    async scrape() { return { markdown: "", metadata: {} }; }
    async map() { return { links: [] }; }
    async startCrawl() { return { crawlId: "crawl_test", jobId: "job_test" }; }
  }
  return { FirecrawlClient };
});

/** Seeds a mission plus a plan and one pending search query. */
async function seedMission(t: TestT) {
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
    await ctx.db.insert("missionQueries", {
      missionId, query: "query number 0", kind: "search" as const,
      status: "pending" as const, resultCount: null, createdAt: now,
    });
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
    return run ? { status: run.status, currentStage: run.currentStage, interruption: run.activeInterruption } : null;
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

/**
 * Parks a run in the crawl wait state, backdated past the watchdog window and
 * with a `crawl.awaiting` event as its latest recorded event — exactly what a
 * run that started a durable crawl and never heard back looks like.
 */
async function stallOnCrawl(t: TestT, missionId: string, options: { storedSources: number; eventType?: string; ageMs?: number; interruption?: string | null }) {
  await t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    const parkedAt = Date.now() - (options.ageMs ?? CRAWL_WAIT_MS + 60 * 60 * 1000);
    await ctx.db.patch(run!._id, { updatedAt: parkedAt, ...(options.interruption !== undefined ? { activeInterruption: options.interruption } : {}) });
    await ctx.db.insert("runEvents", {
      missionId: missionId as never,
      runId: run!._id,
      type: options.eventType ?? "crawl.awaiting",
      stage: "wait" as never,
      safeSummary: "Deep crawl of acme.example.com is running; Radar will continue automatically when it completes.",
      createdAt: parkedAt,
    });
    if (options.storedSources > 0) {
      const jobId = await ctx.db.insert("researchJobs", {
        missionId: missionId as never,
        runId: run!._id,
        requestId: "req_stalled_crawl",
        operation: "crawl" as never,
        query: "https://acme.example.com",
        status: "running" as never,
        provider: "firecrawl" as const,
        providerRequestId: null,
        resultCount: 0,
        crawlId: "crawl_stalled",
        crawlStatus: null,
        errorCode: null,
        errorSummary: null,
        createdAt: parkedAt,
        startedAt: parkedAt,
        finishedAt: null,
        updatedAt: parkedAt,
      });
      for (let index = 0; index < options.storedSources; index += 1) {
        await ctx.db.insert("sourceRecords", {
          missionId: missionId as never,
          jobId,
          url: `https://acme.example.com/page-${index}`,
          title: `Acme page ${index}`,
          sourceType: "crawled_page" as never,
          excerpt: "Acme is hiring a frontend partner.",
          content: null,
          fetchedAt: parkedAt,
          freshness: "fresh" as never,
          firecrawlRequestId: null,
          firecrawlPageId: null,
          processingStatus: "scraped" as never,
          errorSummary: null,
          createdAt: parkedAt,
          updatedAt: parkedAt,
        });
      }
    }
  });
}

describe("crawl watchdog", () => {
  it("resumes a run whose crawl never reported back, using the sources already stored", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    await stallOnCrawl(t, missionId, { storedSources: 3 });

    const result = await t.run((ctx) => ctx.runMutation(internal.crawlWatchdog.resumeStalledCrawls, {}));
    expect(result.resumed).toBe(1);
    expect(result.blocked).toBe(0);

    const run = await getRun(t, missionId);
    // Back to work at the stage a real crawl callback would have delivered it to.
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("evaluate");
    expect(run?.interruption).toBeNull();

    const step = (await stepsFor(t, missionId)).find((entry) => entry.label === "crawl.timed_out");
    expect(step).toBeTruthy();
    expect(step!.tool).toBe("crawlWatchdog");
    expect(step!.errorCode).toBe("CRAWL_TIMED_OUT");
    expect(step!.summary).toContain("3 sources");
  });

  it("never resumes a send that is legitimately waiting on a counterpart's reply", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    await stallOnCrawl(t, missionId, {
      storedSources: 1,
      eventType: "action.sent",
      interruption: "Waiting for delivery confirmation or an inbound reply.",
    });

    const result = await t.run((ctx) => ctx.runMutation(internal.crawlWatchdog.resumeStalledCrawls, {}));
    expect(result.resumed).toBe(0);
    expect(result.blocked).toBe(0);

    const run = await getRun(t, missionId);
    expect(run?.status).toBe("waiting");
    expect(run?.interruption).toBe("Waiting for delivery confirmation or an inbound reply.");
  });

  it("parks a timed-out crawl that stored nothing as a visible, resumable failure", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    await stallOnCrawl(t, missionId, { storedSources: 0 });

    const result = await t.run((ctx) => ctx.runMutation(internal.crawlWatchdog.resumeStalledCrawls, {}));
    expect(result.resumed).toBe(0);
    expect(result.blocked).toBe(1);

    const run = await getRun(t, missionId);
    expect(run?.status).toBe("blocked");
    // The stage is kept, so the ordinary retry control resumes exactly there.
    expect(run?.currentStage).toBe("wait");
    expect(run?.interruption).toBe("crawl_timed_out");
  });

  it("leaves a crawl still inside its window alone and fires at most once per run", async () => {
    const t = convexTest(schema, convexModules);
    const fresh = await seedMission(t);
    await forceStage(t, fresh, "wait", "waiting");
    await stallOnCrawl(t, fresh, { storedSources: 1, ageMs: 60 * 1000 });

    const stalled = await seedMission(t);
    await forceStage(t, stalled, "wait", "waiting");
    await stallOnCrawl(t, stalled, { storedSources: 1 });

    const first = await t.run((ctx) => ctx.runMutation(internal.crawlWatchdog.resumeStalledCrawls, {}));
    expect(first.resumed).toBe(1);
    expect(first.blocked).toBe(0);
    expect((await getRun(t, fresh))?.status).toBe("waiting");

    // The resumed run is no longer `waiting`, so a second sweep cannot double-fire.
    const second = await t.run((ctx) => ctx.runMutation(internal.crawlWatchdog.resumeStalledCrawls, {}));
    expect(second.resumed).toBe(0);
    const steps = (await stepsFor(t, stalled)).filter((entry) => entry.label === "crawl.timed_out");
    expect(steps).toHaveLength(1);
  });
});
