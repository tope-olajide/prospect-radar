import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

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

async function eventsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (!run) return [];
    const events = await ctx.db.query("runEvents").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect();
    return events.map((event) => event.type);
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

/** Seeds a running crawl job for the mission, plus stored sources if requested. */
async function seedCrawlJob(t: TestT, missionId: string, options: { storedSources: number; pendingQueries?: number }) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId: missionId as never,
      runId: run!._id,
      requestId: "req_crawl",
      operation: "crawl" as never,
      query: "https://www.indeed.com/jobs?q=React",
      status: "running" as never,
      provider: "firecrawl" as const,
      providerRequestId: null,
      resultCount: 0,
      crawlId: "crawl_indeed",
      crawlStatus: null,
      errorCode: null,
      errorSummary: null,
      createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
    });
    for (let index = 0; index < options.storedSources; index += 1) {
      await ctx.db.insert("sourceRecords", {
        missionId: missionId as never, jobId, url: `https://acme.example.com/page-${index}`,
        title: `Acme page ${index}`, sourceType: "search_result" as never,
        excerpt: "Acme needs a frontend partner.", content: null, fetchedAt: now,
        freshness: "fresh" as never, firecrawlRequestId: null, firecrawlPageId: null,
        processingStatus: "scraped" as never, errorSummary: null, createdAt: now, updatedAt: now,
      });
    }
    for (let index = 0; index < (options.pendingQueries ?? 0); index += 1) {
      await ctx.db.insert("missionQueries", {
        missionId: missionId as never, query: `query ${index}`, kind: "search" as never,
        status: "pending" as never, resultCount: null, createdAt: now + index,
      });
    }
    return jobId;
  });
}

describe("crawl failure recovery", () => {
  it("continues the mission when a crawl ends without completing but sources were already stored", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 19 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.crawlCompleted, {
        crawlId: "crawl_indeed",
        jobId: jobId as never,
        status: "failed",
        pageCount: 0,
        error: "ROBOTS_TXT: this site's robots.txt disallows crawling",
        context: { missionId, jobId },
      }),
    );

    // Not a dead mission: the run is handed to evaluate, where the 19 stored
    // sources are resolved into entities and explained.
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("evaluate");
    expect(run?.interruption).toBeNull();

    const step = (await stepsFor(t, missionId)).find((entry) => entry.label === "crawl.failed");
    expect(step).toBeTruthy();
    expect(step!.tool).toBe("firecrawl.crawl");
    expect(step!.errorCode).toBe("CRAWL_FAILED");
    expect(step!.summary).toContain("ROBOTS_TXT");

    // The refusal is still recorded against the job, not hidden.
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.errorSummary).toContain("ROBOTS_TXT");
  });

  it("continues when the failed crawl stored nothing but other discovery is still pending", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 0, pendingQueries: 3 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.crawlCompleted, {
        crawlId: "crawl_indeed", jobId: jobId as never, status: "failed", pageCount: 0,
        error: "ROBOTS_TXT", context: { missionId, jobId },
      }),
    );

    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("evaluate");
  });

  it("fails honestly only when the mission has neither evidence nor pending work", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 0 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.crawlCompleted, {
        crawlId: "crawl_indeed", jobId: jobId as never, status: "failed", pageCount: 0,
        error: "ROBOTS_TXT", context: { missionId, jobId },
      }),
    );

    const run = await getRun(t, missionId);
    expect(run?.status).toBe("failed");
    expect(run?.interruption).toBe("Firecrawl crawl did not complete. Retry after reviewing the error.");
  });

  it("a failed provider job is recorded without killing the run that is still working", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "active");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 0 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.failJob, {
        jobId: jobId as never,
        errorSummary: "ROBOTS_TXT: this site's robots.txt disallows crawling",
        errorCode: "FIRECRAWL_ROBOTS_TXT",
      }),
    );

    // The orchestrator owns recovery: the run keeps its stage and stays working.
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.currentStage).toBe("discover");

    const steps = await stepsFor(t, missionId);
    expect(steps.some((entry) => entry.label === "firecrawl.crawl.failed")).toBe(true);
  });

  it("a scheduled retry re-opens the block that scheduled it, then the stage runs", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "blocked");
    await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      await ctx.db.patch(run!._id, { activeInterruption: "FIRECRAWL_RATE_LIMITED" });
    });

    // The retry path: matching interruption → unblocks and schedules the stage.
    const resumed = await t.run((ctx) =>
      ctx.runMutation(internal.orchestratorStore.retryResume, { missionId: missionId as never, interruption: "FIRECRAWL_RATE_LIMITED" }),
    );
    expect(resumed.resumed).toBe(true);
    const run = await getRun(t, missionId);
    expect(run?.status).toBe("active");
    expect(run?.interruption).toBeNull();
    const events = await t.run(async (ctx) => {
      const row = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      const list = await ctx.db.query("runEvents").withIndex("by_runId", (q) => q.eq("runId", row!._id)).collect();
      return list.map((entry) => entry.type);
    });
    expect(events).toContain("stage.discover.retrying");
  });

  it("wakes the parked run when a crawl completes successfully, not just when one fails", async () => {
    // The live regression: a mission parked in `wait` had its run moved to
    // `evaluate` by this callback and nothing scheduled, so it sat `active`
    // with no invocation in flight for fifteen minutes until it was nudged by
    // hand. The failure branch always scheduled; the success branch did not.
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "wait", "waiting");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 2 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.crawlCompleted, {
        crawlId: "crawl_indeed", jobId: jobId as never, status: "completed", pageCount: 2,
        context: { missionId, jobId },
      }),
    );

    // The callback moved the run...
    const moved = await getRun(t, missionId);
    expect(moved?.status).toBe("active");
    expect(moved?.currentStage).toBe("evaluate");

    // ...and scheduling is what turns that move into actual work. Draining the
    // scheduler here runs exactly what the callback queued. With nothing queued
    // the run stays untouched at `evaluate` and the only event in its history
    // is the callback's own; the stage's conclusion is what proves it ran.
    await t.finishAllScheduledFunctions(() => {});
    const events = await eventsFor(t, missionId);
    expect(
      events.some((type) => type === "stage.approval.started" || type === "stage.evaluate.failed"),
    ).toBe(true);
    const run = await getRun(t, missionId);
    expect(run?.status === "active" && run?.currentStage === "evaluate").toBe(false);
  });

  it("never parks a run whose crawl already finished", async () => {
    // The race in the other direction: a fast crawl can complete before the
    // await commits. Parking then would drag a working run back into `wait`
    // with no crawl left to wait for.
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t);
    await forceStage(t, missionId, "discover", "active");
    const jobId = await seedCrawlJob(t, missionId, { storedSources: 1, pendingQueries: 1 });

    await t.run((ctx) =>
      ctx.runMutation(internal.researchStore.crawlCompleted, {
        crawlId: "crawl_indeed", jobId: jobId as never, status: "completed", pageCount: 1,
        context: { missionId, jobId },
      }),
    );
    const queryId = await t.run(async (ctx) =>
      (await ctx.db.query("missionQueries").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first())!._id,
    );
    await t.run((ctx) => ctx.runMutation(internal.orchestratorStore.awaitCrawl, {
      queryId, missionId: missionId as never, host: "www.indeed.com", jobId: jobId as never,
    }));

    const run = await getRun(t, missionId);
    expect(run?.currentStage).toBe("evaluate");
    expect(run?.status).toBe("active");
  });

  it("a retry resume never steals a run the user owns (stopped, budget-blocked, or re-classified)", async () => {
    const t = convexTest(schema, convexModules);
    const stopped = await seedMission(t);
    await forceStage(t, stopped, "discover", "cancelled");
    const budgetBlocked = await seedMission(t);
    await forceStage(t, budgetBlocked, "discover", "blocked");
    await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", budgetBlocked as never)).first();
      await ctx.db.patch(run!._id, { activeInterruption: "budget_blocked" });
    });
    const reclassified = await seedMission(t);
    await forceStage(t, reclassified, "discover", "blocked");
    await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", reclassified as never)).first();
      await ctx.db.patch(run!._id, { activeInterruption: "OPENAI_SCHEMA_INVALID" });
    });

    // Same interruption code a rate-limit retry would carry: none of these runs
    // may be stolen by it.
    for (const id of [stopped, budgetBlocked, reclassified]) {
      const result = await t.run((ctx) =>
        ctx.runMutation(internal.orchestratorStore.retryResume, { missionId: id as never, interruption: "FIRECRAWL_RATE_LIMITED" }),
      );
      expect(result.resumed).toBe(false);
    }
    expect((await getRun(t, stopped))?.status).toBe("cancelled");
    expect((await getRun(t, budgetBlocked))?.interruption).toBe("budget_blocked");
    expect((await getRun(t, reclassified))?.interruption).toBe("OPENAI_SCHEMA_INVALID");
  });
});
