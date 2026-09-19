import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { extractionPromptFor, snippetExtraction, validateExtraction } from "../convex/research";
import { normalizeEntityName } from "../convex/entityStore";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

// The Firecrawl client is constructed at module load in research.ts, so the
// mock must exist before the glob imports run — same pattern as the
// AgentMail mock in the trust suite.
let scrapeImpl: (url: string, options?: unknown) => Promise<unknown> = async () => ({});
vi.mock("@firecrawl/firecrawl-convex", () => {
  class FirecrawlClient {
    constructor(_component: unknown) {}
    async scrape(_ctx: unknown, url: string, options?: unknown) {
      return scrapeImpl(url, options);
    }
    async search() {
      return { web: [] };
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

/** Seeds a mission with one scraped source. */
async function seedSource(t: TestT, url = "https://acme.example.com/about", title = "Acme Corp") {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Find companies that need React development.",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists.",
    });
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).first();
    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId, runId: run!._id, requestId: `req-${now}`, operation: "search", query: "q",
      status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null,
      errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId, jobId, url, title, sourceType: "scraped_page",
      excerpt: "Acme builds climate analytics dashboards.",
      content: "Acme Corp is hiring a frontend engineer to rebuild its dashboard.",
      fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null,
      processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now,
    });
    return { missionId: missionId as unknown as string, sourceId: sourceId as unknown as string };
  });
}

function entitiesFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => ctx.db.query("entities").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
}

function signalsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => ctx.db.query("entitySignals").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  scrapeImpl = async () => ({ json: validExtraction() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

function validExtraction(overrides: Record<string, unknown> = {}) {
  return {
    entityName: "Acme Corp",
    entityType: "organization",
    expressedNeed: "Needs a frontend engineer for its dashboard rebuild",
    skillsOrOffer: ["Climate analytics platform"],
    signals: [{ type: "hiring", statement: "Acme Corp is hiring a frontend engineer." }],
    contactRoute: { kind: "email", value: "hello@acme.example.com", publicSource: "https://acme.example.com/contact" },
    summary: "Climate analytics company rebuilding its dashboard.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("validateExtraction — schema validation", () => {
  it("accepts a well-formed extraction and clamps the confidence", () => {
    const result = validateExtraction(validExtraction({ confidence: 4 }));
    expect(result?.entityName).toBe("Acme Corp");
    expect(result?.entityType).toBe("organization");
    expect(result?.confidence).toBe(1);
  });

  it("rejects a payload with no entity name or an unknown entity type", () => {
    expect(validateExtraction(validExtraction({ entityName: "" }))).toBeNull();
    expect(validateExtraction(validExtraction({ entityType: "alien" }))).toBeNull();
    expect(validateExtraction(null)).toBeNull();
    expect(validateExtraction("nope")).toBeNull();
  });

  it("drops invalid signals but keeps valid ones", () => {
    const result = validateExtraction(validExtraction({
      signals: [
        { type: "hiring", statement: "Hiring a frontend engineer." },
        { type: "not_a_type", statement: "ignored" },
        { type: "launch", statement: "" },
      ],
    }));
    expect(result?.signals).toHaveLength(1);
    expect(result?.signals[0].type).toBe("hiring");
  });

  it("treats kind 'none' as no contact route", () => {
    const result = validateExtraction(validExtraction({ contactRoute: { kind: "none", value: "", publicSource: "" } }));
    expect(result?.contactRoute).toBeNull();
  });
});

describe("snippetExtraction / normalizeEntityName — deterministic fallbacks", () => {
  it("builds a snippet-only entity from the source when extraction is unavailable", () => {
    const fallback = snippetExtraction({ url: "https://acme.example.com", title: "", excerpt: "Some snippet." });
    expect(fallback.entityName).toBe("acme.example.com");
    expect(fallback.entityType).toBe("organization");
    expect(fallback.contactRoute).toBeNull();
    expect(fallback.confidence).toBeLessThan(0.5);
  });

  it("normalizes legal suffixes for name dedupe", () => {
    expect(normalizeEntityName("Acme Corp.")).toBe("acme");
    expect(normalizeEntityName("ACME, Inc")).toBe("acme");
    expect(normalizeEntityName("Acme Limited")).toBe("acme");
    expect(normalizeEntityName("Beta Labs LLC")).toBe("beta labs");
  });
});

describe("extractFromSource — Firecrawl JSON mode through the real action", () => {
  it("persists an extracted entity with signals and a sourced contact route", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });

    expect(result.status).toBe("extracted");
    expect(result.signals).toBe(1);
    const entities = await entitiesFor(t, missionId);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      name: "Acme Corp",
      kind: "organization",
      extractionStatus: "extracted",
      expressedNeed: "Needs a frontend engineer for its dashboard rebuild",
    });
    expect(entities[0].contactRoute).toMatchObject({ kind: "email", value: "hello@acme.example.com", publicSource: "https://acme.example.com/contact" });
    expect(entities[0].attributes.some((a) => a.key === "expressed_need")).toBe(true);

    // A transcript receipt names the tool that produced the entity.
    const steps = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      return await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run!._id)).collect();
    });
    expect(steps.some((s) => s.label === "entity.extracted" && s.tool === "firecrawl.extract")).toBe(true);
  });

  it("is idempotent per source: a second call adds no entity", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r2" });
    expect(await entitiesFor(t, missionId)).toHaveLength(1);
    expect(await signalsFor(t, missionId)).toHaveLength(1);
  });

  it("falls back to a snippet-only entity when the provider shape is invalid", async () => {
    scrapeImpl = async () => ({ json: { entityName: "", entityType: "unknown" } });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    expect(result.status).toBe("snippet_only");
    const entities = await entitiesFor(t, missionId);
    expect(entities).toHaveLength(1);
    expect(entities[0].extractionStatus).toBe("snippet_only");
    expect(entities[0].contactRoute).toBeUndefined();
    const steps = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      return await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run!._id)).collect();
    });
    const fallback = steps.find((s) => s.label === "entity.snippet_fallback");
    expect(fallback?.errorCode).toBe("OPENAI_SCHEMA_INVALID");
  });

  it("falls back (never throws) when Firecrawl itself errors", async () => {
    scrapeImpl = async () => { throw new Error("Insufficient credits to perform this request (402)."); };
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    expect(result.status).toBe("snippet_only");
    const steps = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      return await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run!._id)).collect();
    });
    expect(steps.find((s) => s.label === "entity.snippet_fallback")?.errorCode).toBe("FIRECRAWL_CREDITS_EXHAUSTED");
  });

  it("drops a contact route whose value is not a real email and keeps a sourced one", async () => {
    scrapeImpl = async () => ({ json: validExtraction({ contactRoute: { kind: "email", value: "not-an-email", publicSource: "https://acme.example.com/contact" } }) });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    const entities = await entitiesFor(t, missionId);
    expect(entities[0].contactRoute).toBeUndefined();
  });

  it("rebuilds a relative public source into an absolute URL", async () => {
    scrapeImpl = async () => ({ json: validExtraction({ contactRoute: { kind: "form", value: "https://acme.example.com/contact", publicSource: "/contact" } }) });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    const entities = await entitiesFor(t, missionId);
    expect(entities[0].contactRoute?.publicSource).toBe("https://acme.example.com/contact");
  });
});

describe("resolveEntities — batch worklist", () => {
  it("skips sources that already have an entity and respects the workspace scope", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const first = await t.action(api.research.resolveEntities, { workspaceId: WORKSPACE, missionId: missionId as never, limit: 6 });
    expect(first.resolved).toBe(1);
    expect(first.extracted).toBe(1);
    // Nothing left to resolve.
    const second = await t.action(api.research.resolveEntities, { workspaceId: WORKSPACE, missionId: missionId as never, limit: 6 });
    expect(second.resolved).toBe(0);
    // Cross-workspace is refused.
    await expect(t.action(api.research.resolveEntities, { workspaceId: "attacker", missionId: missionId as never, limit: 6 })).rejects.toThrow("FORBIDDEN_SCOPE");
    void sourceId;
  });
});

describe("upsertFromExtraction — dedupe and merge", () => {
  it("merges two sources describing the same entity by canonical URL", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    // A second source, same page URL, discovered through another query.
    const second = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      const now = Date.now();
      const jobId = await ctx.db.insert("researchJobs", { missionId: missionId as never, runId: run!._id, requestId: "req-2", operation: "scrape", query: "https://acme.example.com/about", status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null, errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now });
      return await ctx.db.insert("sourceRecords", { missionId: missionId as never, jobId, url: "https://acme.example.com/about", title: "Acme", sourceType: "scraped_page", excerpt: "e", content: "c", fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now });
    });
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: second as never, requestId: "r2" });
    // Same URL → same entity; signals deduped by (entity, evidenceUrl).
    expect(await entitiesFor(t, missionId)).toHaveLength(1);
    expect(await signalsFor(t, missionId)).toHaveLength(1);
  });

  it("merges entities found at different URLs when the normalized name matches", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    scrapeImpl = async () => ({ json: validExtraction({ entityName: "ACME, Inc", signals: [{ type: "funding", statement: "Acme raised a Series B." }] }) });
    const other = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      const now = Date.now();
      const jobId = await ctx.db.insert("researchJobs", { missionId: missionId as never, runId: run!._id, requestId: "req-3", operation: "search", query: "acme funding", status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null, errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now });
      return await ctx.db.insert("sourceRecords", { missionId: missionId as never, jobId, url: "https://news.example.com/acme-series-b", title: "Acme raises Series B", sourceType: "search_result", excerpt: "e", content: "c", fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now });
    });
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: other as never, requestId: "r2" });
    const entities = await entitiesFor(t, missionId);
    expect(entities).toHaveLength(1);
    // The new signal from the second page is kept (different evidence URL).
    const signals = await signalsFor(t, missionId);
    expect(signals).toHaveLength(2);
    expect(signals.some((s) => s.type === "funding")).toBe(true);
  });

  it("upgrades a snippet-only entity to extracted when a real extraction arrives", async () => {
    scrapeImpl = async () => ({ json: { bad: true } });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    expect((await entitiesFor(t, missionId))[0].extractionStatus).toBe("snippet_only");
    // Force a re-resolve path: delete the entity link is not possible, so call
    // upsert directly as the upgrade path the resolver uses for new sources.
    scrapeImpl = async () => ({ json: validExtraction() });
    await t.run(async (ctx) => ctx.runMutation(internal.entityStore.upsertFromExtraction, {
      missionId: missionId as never,
      workspaceId: WORKSPACE,
      sourceId: sourceId as never,
      pageUrl: "https://acme.example.com/about",
      extractionStatus: "extracted",
      extraction: {
        entityName: "Acme Corp", entityType: "organization",
        expressedNeed: "Needs a frontend engineer", skillsOrOffer: [],
        signals: [], contactRoute: null, summary: "s", confidence: 0.9,
      },
    }));
    const entities = await entitiesFor(t, missionId);
    expect(entities).toHaveLength(1);
    expect(entities[0].extractionStatus).toBe("extracted");
  });
});

describe("explainMatches — grounding in extracted entities", () => {
  it("sends entity attributes, signals, and the contact route to the model", async () => {
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { messages?: Array<{ content?: string }> };
      const prompt = (body.messages ?? []).map((m) => m.content ?? "").join("\n");
      prompts.push(prompt);
      // Echo the real matchId the action supplied, so the explanation passes
      // the id validation the action performs.
      const matchId = /"matchId\\?":\s*"([^"]+)"/.exec(prompt)?.[1] ?? "missing";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ explanations: [{ matchId, label: "promising", positiveEvidence: ["e"], unknowns: [], risks: [], recommendedAction: "research_alt_route", summary: "s" }] }) } }] }), { status: 200 });
    }));
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    // Seed the match + intent + requester context the explain action reads.
    await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      const now = Date.now();
      const discoveryId = await ctx.db.insert("discoveries", { missionId: missionId as never, sourceId: sourceId as never, subject: "Acme Corp", signal: "s", publishedAt: null, extractedFields: [], createdAt: now, updatedAt: now });
      await ctx.db.insert("matches", { missionId: missionId as never, discoveryId, sourceId: sourceId as never, label: "uncertain", positiveEvidence: [], unknowns: [], risks: [], freshness: "fresh", recommendedAction: "review", createdAt: now, updatedAt: now });
      await ctx.db.insert("missionPlans", { missionId: missionId as never, normalizedGoal: "Find companies needing React work.", mode: "opportunity", mustHave: ["needs React"], niceToHave: [], exclusions: [], missingFacts: [], recommendedSources: [], proposedSteps: [], completionPredicate: "one send", provider: "openai", model: "test", createdAt: now });
      await ctx.db.patch(run!._id, { currentStage: "evaluate", status: "active" });
    });
    await t.action(api.ai.explainMatches, { missionId: missionId as never });
    const prompt = prompts.join("\n");
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("Needs a frontend engineer for its dashboard rebuild");
    expect(prompt).toContain("hiring");
    expect(prompt).toContain("hello@acme.example.com");
    expect(prompt).toContain("https://acme.example.com/contact");
    // And the rule that matters: no route → research an alternate route.
    expect(prompt).toContain("research_alt_route");

    // The sentinel is a decision, not copy. It may be stored, but it must never
    // reach a client: the match card renders this string verbatim, so leaking it
    // showed users the literal text "Next research_alt_route".
    const matches = await t.query(api.researchStore.listMatches, { missionId: missionId as never });
    expect(matches).toHaveLength(1);
    expect(matches[0].recommendedAction).not.toBe("research_alt_route");
    expect(matches[0].recommendedAction).toMatch(/no public contact channel/i);

    // The stored value keeps the machine decision, so it stays inspectable.
    const stored = await t.run(async (ctx) => (await ctx.db.query("matches").collect())[0]);
    expect(stored.recommendedAction).toBe("research_alt_route");
  });
});

/** One chat/completions reply body. */
function llmResponse(body: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });
}

/** Reads the prompt the last LLM request carried. */
function promptOf(init?: { body?: string }) {
  const body = JSON.parse(init?.body ?? "{}") as { messages?: Array<{ content?: string }> };
  return (body.messages ?? []).map((message) => message.content ?? "").join("\n");
}

/** Seeds the match, plan, and run state `explainMatches` reads. */
async function seedExplainable(t: TestT, missionId: string, sourceId: string) {
  await t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    const now = Date.now();
    const discoveryId = await ctx.db.insert("discoveries", { missionId: missionId as never, sourceId: sourceId as never, subject: "Acme Corp", signal: "s", publishedAt: null, extractedFields: [], createdAt: now, updatedAt: now });
    // Matches are created with the citation they were retrieved on, as the
    // research store does; an explanation adds to it, never replaces it.
    await ctx.db.insert("matches", { missionId: missionId as never, discoveryId, sourceId: sourceId as never, label: "uncertain", positiveEvidence: ["Acme builds climate analytics dashboards."], unknowns: [], risks: [], freshness: "fresh", recommendedAction: "review", createdAt: now, updatedAt: now });
    await ctx.db.insert("missionPlans", { missionId: missionId as never, normalizedGoal: "Find companies needing React work.", mode: "opportunity", mustHave: ["needs React"], niceToHave: [], exclusions: [], missingFacts: [], recommendedSources: [], proposedSteps: [], completionPredicate: "one send", provider: "openai", model: "test", createdAt: now });
    await ctx.db.patch(run!._id, { currentStage: "evaluate", status: "active" });
  });
}

function stepsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (!run) return [];
    return ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect();
  });
}

describe("extractFromSource — the prompt is framed by the mission", () => {
  it("carries the mission goal, its must-haves, and the target-class rules", async () => {
    let prompt = "";
    scrapeImpl = async (_url, options) => {
      prompt = ((options as { formats?: Array<{ prompt?: string }> } | undefined)?.formats?.[0]?.prompt) ?? "";
      return { json: validExtraction() };
    };
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("missionPlans", { missionId: missionId as never, normalizedGoal: "Find companies needing React work.", mode: "opportunity", mustHave: ["evidence of a current React need"], niceToHave: [], exclusions: [], missingFacts: [], recommendedSources: [], proposedSteps: [], completionPredicate: "one send", provider: "openai", model: "test", createdAt: Date.now() });
    });
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });

    expect(prompt).toContain("Find companies needing React work.");
    expect(prompt).toContain("evidence of a current React need");
    // The rules that stop a listing page resolving to a role instead of a company.
    expect(prompt).toContain("Never return a job title");
    expect(prompt).toContain("listing, directory, job board");
  });

  it("states the target entity family the mission classified", () => {
    const person = extractionPromptFor(
      { goal: "Find a React developer.", intent: "find_person", targetEntity: "person", mustHave: ["React"] },
      { url: "https://example.com", title: "Example" },
    );
    expect(person).toContain("targets a person");
    expect(person).toContain('entityType must be "person"');
    // Without mission framing the prompt is still the full base contract.
    const bare = extractionPromptFor(null, { url: "https://example.com", title: "Example" });
    expect(bare).toContain("never invent names");
    expect(bare).not.toContain("targets a");
  });
});

describe("explainMatches — a label without a citation is not a claim", () => {
  it("nudges the model once when a labelled match carries no evidence", async () => {
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const prompt = promptOf(init);
      prompts.push(prompt);
      const matchId = /"matchId\\?":\s*"([^"]+)"/.exec(prompt)?.[1] ?? "missing";
      // The exact shape a live run produced: every required key present, every
      // evidence array empty.
      if (prompts.length === 1) {
        return llmResponse({ explanations: [{ matchId, label: "promising", positiveEvidence: [], unknowns: [], risks: [], recommendedAction: "research_alt_route", summary: "s" }] });
      }
      return llmResponse({ explanations: [{ matchId, label: "promising", positiveEvidence: ["Acme Corp is hiring a frontend engineer."], unknowns: ["Budget is unverified."], risks: [], recommendedAction: "research_alt_route", summary: "s" }] });
    }));
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    await seedExplainable(t, missionId, sourceId);
    await t.action(api.ai.explainMatches, { missionId: missionId as never });

    // One repair round-trip, and it named the field that was missing.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("positiveEvidence");
    const stored = await t.run(async (ctx) => (await ctx.db.query("matches").collect())[0]);
    expect(stored.label).toBe("promising");
    expect(stored.positiveEvidence).toEqual(["Acme Corp is hiring a frontend engineer."]);
    expect(stored.unknowns).toEqual(["Budget is unverified."]);
  });

  it("withdraws an unsupported ranking instead of blocking the mission", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      calls += 1;
      const matchId = /"matchId\\?":\s*"([^"]+)"/.exec(promptOf(init))?.[1] ?? "missing";
      // A model that will not cite anything, even after being asked.
      return llmResponse({ explanations: [{ matchId, label: "stronger", positiveEvidence: [], unknowns: [], risks: [], recommendedAction: "research_alt_route", summary: "s" }] });
    }));
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await t.action(api.research.extractFromSource, { missionId: missionId as never, sourceId: sourceId as never, requestId: "r1" });
    await seedExplainable(t, missionId, sourceId);

    // The stage completes rather than failing the run...
    await t.action(api.ai.explainMatches, { missionId: missionId as never });
    expect(calls).toBe(2);
    const stored = await t.run(async (ctx) => (await ctx.db.query("matches").collect())[0]);
    // ...but the ungrounded "stronger" claim is withdrawn and says why...
    expect(stored.label).toBe("uncertain");
    expect(stored.unknowns.join(" ")).toMatch(/could not confirm the fit/i);
    // ...and the citation the match was found on survives, so the evidence panel
    // still renders something real instead of nothing.
    expect(stored.positiveEvidence).toEqual(["Acme builds climate analytics dashboards."]);
  });
});

describe("evaluate — entity resolution covers the whole discovery, not one batch", () => {
  it("re-enters the stage until every scraped source has an entity", async () => {
    // Distinct hostnames so the entities do not merge into one record.
    scrapeImpl = async (url) => ({ json: validExtraction({ entityName: new URL(url).hostname, contactRoute: null }) });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const matchId = /"matchId\\?":\s*"([^"]+)"/.exec(promptOf(init))?.[1] ?? "missing";
      return llmResponse({ explanations: [{ matchId, label: "promising", positiveEvidence: ["e"], unknowns: [], risks: [], recommendedAction: "research_alt_route", summary: "s" }] });
    }));
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedSource(t);
    // Eight scraped sources — exactly two extraction batches of 4.
    await t.run(async (ctx) => {
      const job = await ctx.db.query("researchJobs").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      const now = Date.now();
      for (let index = 2; index <= 8; index += 1) {
        await ctx.db.insert("sourceRecords", {
          missionId: missionId as never, jobId: job!._id, url: `https://acme${index}.example.com/about`, title: `Acme ${index}`,
          sourceType: "scraped_page", excerpt: "e", content: "c", fetchedAt: now, freshness: "fresh",
          firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now,
        });
      }
    });
    await seedExplainable(t, missionId, (await t.run(async (ctx) => (await ctx.db.query("sourceRecords").first())!._id)) as unknown as string);

    // One pass is bounded (extraction limit), hands the remainder back to the scheduler.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    expect(await entitiesFor(t, missionId)).toHaveLength(4);
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "entity.extraction_continues")).toBe(true);

    // The next pass finishes the remaining sources (4 more = 8 total), then evaluates.
    await t.action(internal.missionOrchestrator.runStage, { missionId: missionId as never });
    expect(await entitiesFor(t, missionId)).toHaveLength(8);
    const run = await t.run(async (ctx) => ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first());
    expect(run?.currentStage).toBe("approval");
  });
});
