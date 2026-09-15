import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { transitionRun } from "./runState";

const researchOperation = v.union(v.literal("search"), v.literal("scrape"), v.literal("map"), v.literal("crawl"));
const crawlStatus = v.union(v.literal("scraping"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"));
const researchJobStatus = v.union(v.literal("running"), v.literal("complete"), v.literal("failed"));
const sourceType = v.union(v.literal("search_result"), v.literal("scraped_page"), v.literal("crawled_page"), v.literal("mapped_site"));
const sourceProcessingStatus = v.union(v.literal("discovered"), v.literal("scraping"), v.literal("scraped"), v.literal("failed"));
const matchLabel = v.union(v.literal("stronger"), v.literal("promising"), v.literal("uncertain"), v.literal("insufficient"));

const explanationInput = v.object({
  matchId: v.id("matches"),
  label: matchLabel,
  positiveEvidence: v.array(v.string()),
  unknowns: v.array(v.string()),
  risks: v.array(v.string()),
  recommendedAction: v.string(),
  summary: v.string(),
  provider: v.union(v.literal("openai"), v.literal("dashscope")),
  model: v.string(),
});

const crawlPageInput = v.object({
  url: v.string(),
  title: v.string(),
  content: v.union(v.string(), v.null()),
  truncated: v.boolean(),
});

export const sourceInput = v.object({
  url: v.string(),
  title: v.string(),
  sourceType,
  excerpt: v.string(),
  content: v.union(v.string(), v.null()),
  freshness: v.string(),
  firecrawlRequestId: v.union(v.string(), v.null()),
  firecrawlPageId: v.union(v.string(), v.null()),
  processingStatus: sourceProcessingStatus,
  label: matchLabel,
});

function bounded(value: string, length: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export const jobResult = v.object({
  jobId: v.id("researchJobs"),
  status: researchJobStatus,
  resultCount: v.number(),
  shouldExecute: v.boolean(),
});

export const startJob = internalMutation({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    operation: researchOperation,
    query: v.string(),
  },
  returns: jobResult,
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) throw new Error("Mission not found.");
    if (!args.requestId.trim() || args.requestId.length > 160) throw new Error("INVALID_ARGUMENT: requestId is required.");
    if (!args.query.trim() || args.query.length > 700) throw new Error("INVALID_ARGUMENT: research query is invalid.");

    const existing = await ctx.db.query("researchJobs")
      .withIndex("by_missionId_and_requestId", (q) => q.eq("missionId", args.missionId).eq("requestId", args.requestId))
      .first();
    if (existing) {
      if (existing.operation !== args.operation || existing.query !== args.query) {
        throw new Error("IDEMPOTENCY_CONFLICT: requestId is already bound to another research request.");
      }
      if (existing.status === "complete" || existing.status === "running") {
        return { jobId: existing._id, status: existing.status, resultCount: existing.resultCount, shouldExecute: false };
      }
      const now = Date.now();
      await ctx.db.patch(existing._id, { status: "running", errorSummary: null, finishedAt: null, startedAt: now, updatedAt: now });
      return { jobId: existing._id, status: "running" as const, resultCount: existing.resultCount, shouldExecute: true };
    }

    const run = await ctx.db.query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .first();
    if (!run) throw new Error("Mission run not found.");
    if (["complete", "failed", "cancelled"].includes(run.status)) throw new Error("RUN_NOT_RESUMABLE: this mission run is terminal.");

    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId: args.missionId,
      runId: run._id,
      requestId: args.requestId,
      operation: args.operation,
      query: args.query.trim(),
      status: "running",
      provider: "firecrawl",
      providerRequestId: null,
      crawlId: null,
      crawlStatus: null,
      resultCount: 0,
      errorSummary: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    });

    if (["intake", "interpret", "plan", "wait"].includes(run.currentStage)) {
      await transitionRun(ctx, {
        missionId: args.missionId,
        targetStage: "discover",
        targetStatus: "active",
        interruption: null,
        eventType: "source.requested",
        safeSummary: `Firecrawl ${args.operation} requested for the mission.`,
      });
    }
    return { jobId, status: "running" as const, resultCount: 0, shouldExecute: true };
  },
});

export const finishJob = internalMutation({
  args: {
    jobId: v.id("researchJobs"),
    providerRequestId: v.union(v.string(), v.null()),
    sources: v.array(sourceInput),
  },
  returns: v.object({ jobId: v.id("researchJobs"), resultCount: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Research job not found.");
    if (job.status === "complete") return { jobId: job._id, resultCount: job.resultCount };

    const now = Date.now();
    const uniqueUrls = new Set<string>();
    let resultCount = 0;
    for (const input of args.sources) {
      const url = normalizedUrl(input.url);
      if (!url || uniqueUrls.has(url)) continue;
      uniqueUrls.add(url);
      const existing = await ctx.db.query("sourceRecords")
        .withIndex("by_missionId_and_url", (q) => q.eq("missionId", job.missionId).eq("url", url))
        .first();
      const currentContent = existing?.content ?? null;
      const content = input.content ?? currentContent;
      const processingStatus = input.processingStatus === "scraped" || existing?.processingStatus === "scraped"
        ? "scraped" as const
        : input.processingStatus;
      const sourceValue = {
        missionId: job.missionId,
        jobId: job._id,
        url,
        title: input.title || existing?.title || new URL(url).hostname,
        sourceType: input.sourceType,
        excerpt: input.excerpt || existing?.excerpt || "",
        content,
        fetchedAt: now,
        freshness: input.freshness,
        firecrawlRequestId: input.firecrawlRequestId ?? args.providerRequestId ?? existing?.firecrawlRequestId ?? null,
        firecrawlPageId: input.firecrawlPageId ?? existing?.firecrawlPageId ?? null,
        processingStatus,
        errorSummary: input.processingStatus === "failed" ? "Firecrawl returned no usable page content." : null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      let sourceId: Id<"sourceRecords">;
      if (existing) {
        await ctx.db.replace(existing._id, sourceValue);
        sourceId = existing._id;
      } else {
        sourceId = await ctx.db.insert("sourceRecords", sourceValue);
      }

      const subject = sourceValue.title || new URL(url).hostname;
      const signal = sourceValue.excerpt || "Public source discovered by Firecrawl.";
      const fields = [
        { key: "url", value: url },
        { key: "source_type", value: sourceValue.sourceType },
      ];
      const discovery = await ctx.db.query("discoveries")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .first();
      let discoveryId: Id<"discoveries">;
      if (discovery) {
        await ctx.db.patch(discovery._id, { subject, signal, extractedFields: fields, updatedAt: now });
        discoveryId = discovery._id;
      } else {
        discoveryId = await ctx.db.insert("discoveries", {
          missionId: job.missionId,
          sourceId,
          subject,
          signal,
          publishedAt: null,
          extractedFields: fields,
          createdAt: now,
          updatedAt: now,
        });
      }

      const existingMatch = await ctx.db.query("matches")
        .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
        .first();
      const matchValue = {
        missionId: job.missionId,
        discoveryId,
        sourceId,
        label: input.label,
        positiveEvidence: sourceValue.excerpt ? [sourceValue.excerpt] : [],
        unknowns: ["Fit has not yet been reviewed against every mission criterion."],
        risks: sourceValue.processingStatus === "failed" ? ["The source did not return usable content."] : [],
        freshness: sourceValue.freshness,
        recommendedAction: "Review the source, then decide whether to prepare outreach.",
        createdAt: existingMatch?.createdAt ?? now,
        updatedAt: now,
      };
      if (existingMatch) await ctx.db.replace(existingMatch._id, matchValue);
      else await ctx.db.insert("matches", matchValue);
      resultCount += 1;
    }

    await ctx.db.patch(job._id, {
      status: "complete",
      providerRequestId: args.providerRequestId,
      resultCount,
      errorSummary: null,
      finishedAt: now,
      updatedAt: now,
    });

    const run = await ctx.db.get(job.runId);
    if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
      if (["discover", "wait"].includes(run.currentStage)) {
        await transitionRun(ctx, {
          missionId: job.missionId,
          targetStage: "evaluate",
          targetStatus: "active",
          interruption: null,
          eventType: "source.ready",
          safeSummary: `Firecrawl persisted ${resultCount} deduplicated source${resultCount === 1 ? "" : "s"}.`,
        });
      }
    }
    return { jobId: job._id, resultCount };
  },
});

export const startCrawlJob = internalMutation({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    url: v.string(),
  },
  returns: v.object({
    jobId: v.id("researchJobs"),
    status: researchJobStatus,
    resultCount: v.number(),
    crawlId: v.union(v.string(), v.null()),
    shouldExecute: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) throw new Error("Mission not found.");
    if (!args.requestId.trim() || args.requestId.length > 160) throw new Error("INVALID_ARGUMENT: requestId is required.");

    const existing = await ctx.db.query("researchJobs")
      .withIndex("by_missionId_and_requestId", (q) => q.eq("missionId", args.missionId).eq("requestId", args.requestId))
      .first();
    if (existing) {
      if (existing.operation !== "crawl" || existing.query !== args.url) {
        throw new Error("IDEMPOTENCY_CONFLICT: requestId is already bound to another research request.");
      }
      return {
        jobId: existing._id,
        status: existing.status,
        resultCount: existing.resultCount,
        crawlId: existing.crawlId,
        shouldExecute: false,
      };
    }

    const run = await ctx.db.query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .first();
    if (!run) throw new Error("Mission run not found.");
    if (["complete", "failed", "cancelled"].includes(run.status)) throw new Error("RUN_NOT_RESUMABLE: this mission run is terminal.");

    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId: args.missionId,
      runId: run._id,
      requestId: args.requestId,
      operation: "crawl",
      query: args.url,
      status: "running",
      provider: "firecrawl",
      providerRequestId: null,
      crawlId: null,
      crawlStatus: null,
      resultCount: 0,
      errorSummary: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    });

    if (["intake", "interpret", "plan", "wait"].includes(run.currentStage)) {
      await transitionRun(ctx, {
        missionId: args.missionId,
        targetStage: "discover",
        targetStatus: "active",
        interruption: null,
        eventType: "source.requested",
        safeSummary: "Firecrawl durable crawl requested for the mission.",
      });
    }
    return { jobId, status: "running" as const, resultCount: 0, crawlId: null, shouldExecute: true };
  },
});

export const attachCrawl = internalMutation({
  args: { jobId: v.id("researchJobs"), crawlId: v.string(), firecrawlJobId: v.string() },
  returns: v.id("researchJobs"),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Research job not found.");
    await ctx.db.patch(job._id, {
      crawlId: args.crawlId,
      crawlStatus: "scraping",
      providerRequestId: args.firecrawlJobId,
      updatedAt: Date.now(),
    });
    return job._id;
  },
});

export const completeCrawlJob = internalMutation({
  args: {
    jobId: v.id("researchJobs"),
    missionId: v.id("missions"),
    crawlId: v.string(),
    crawlStatus: crawlStatus,
    pageCount: v.number(),
    error: v.union(v.string(), v.null()),
    pages: v.array(crawlPageInput),
  },
  returns: v.object({ jobId: v.id("researchJobs"), resultCount: v.number() }),
  handler: async (ctx, args) => completeCrawl(ctx, args),
});

async function completeCrawl(
  ctx: MutationCtx,
  args: {
    jobId: Id<"researchJobs">;
    missionId: Id<"missions">;
    crawlId: string;
    crawlStatus: "scraping" | "completed" | "failed" | "cancelled";
    pageCount: number;
    error: string | null;
    pages: Array<{ url: string; title: string; content: string | null; truncated: boolean }>;
  },
): Promise<{ jobId: Id<"researchJobs">; resultCount: number }> {
  {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Research job not found.");
    if (job.status === "complete") return { jobId: job._id, resultCount: job.resultCount };

    const now = Date.now();
    let resultCount = 0;
    if (args.crawlStatus === "completed") {
      for (const page of args.pages) {
        const url = normalizedUrl(page.url);
        if (!url) continue;
        const existing = await ctx.db.query("sourceRecords")
          .withIndex("by_missionId_and_url", (q) => q.eq("missionId", job.missionId).eq("url", url))
          .first();
        const content = page.content ?? existing?.content ?? null;
        const sourceValue = {
          missionId: job.missionId,
          jobId: job._id,
          url,
          title: page.title || existing?.title || new URL(url).hostname,
          sourceType: "crawled_page" as const,
          excerpt: content ? bounded(content, 500) : "Crawled page stored without usable text content.",
          content,
          fetchedAt: now,
          freshness: "fresh",
          firecrawlRequestId: args.crawlId,
          firecrawlPageId: null,
          processingStatus: content ? ("scraped" as const) : ("failed" as const),
          errorSummary: content ? null : "Firecrawl crawl returned no usable page content.",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        let sourceId: Id<"sourceRecords">;
        if (existing) {
          await ctx.db.replace(existing._id, sourceValue);
          sourceId = existing._id;
        } else {
          sourceId = await ctx.db.insert("sourceRecords", sourceValue);
        }

        const subject = sourceValue.title;
        const signal = sourceValue.excerpt || "Public source captured by a durable Firecrawl crawl.";
        const fields = [
          { key: "url", value: url },
          { key: "source_type", value: sourceValue.sourceType },
        ];
        const discovery = await ctx.db.query("discoveries")
          .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
          .first();
        let discoveryId: Id<"discoveries">;
        if (discovery) {
          await ctx.db.patch(discovery._id, { subject, signal, extractedFields: fields, updatedAt: now });
          discoveryId = discovery._id;
        } else {
          discoveryId = await ctx.db.insert("discoveries", {
            missionId: job.missionId,
            sourceId,
            subject,
            signal,
            publishedAt: null,
            extractedFields: fields,
            createdAt: now,
            updatedAt: now,
          });
        }

        const existingMatch = await ctx.db.query("matches")
          .withIndex("by_discoveryId", (q) => q.eq("discoveryId", discoveryId))
          .first();
        const matchValue = {
          missionId: job.missionId,
          discoveryId,
          sourceId,
          label: content ? ("promising" as const) : ("insufficient" as const),
          positiveEvidence: content ? [bounded(content, 300)] : [],
          unknowns: ["Crawled content has not yet been reviewed against the mission criteria."],
          risks: content ? [] : ["The crawled page did not return usable content."],
          freshness: sourceValue.freshness,
          recommendedAction: "Review the crawled page, then decide whether to prepare outreach.",
          createdAt: existingMatch?.createdAt ?? now,
          updatedAt: now,
        };
        if (existingMatch) await ctx.db.replace(existingMatch._id, matchValue);
        else await ctx.db.insert("matches", matchValue);
        resultCount += 1;
      }
    }

    const failed = args.crawlStatus !== "completed";
    await ctx.db.patch(job._id, {
      status: failed ? "failed" : "complete",
      crawlId: args.crawlId,
      crawlStatus: args.crawlStatus,
      resultCount,
      errorSummary: failed
        ? bounded(args.error ?? `Firecrawl crawl ended with status ${args.crawlStatus}.`, 240)
        : null,
      finishedAt: now,
      updatedAt: now,
    });

    const run = await ctx.db.get(job.runId);
    if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
      await transitionRun(ctx, {
        missionId: job.missionId,
        targetStage: failed ? run.currentStage : "evaluate",
        targetStatus: failed ? "failed" : "active",
        interruption: failed ? "Firecrawl crawl did not complete. Retry after reviewing the error." : null,
        eventType: failed ? "source.failed" : "source.ready",
        safeSummary: failed
          ? "Firecrawl crawl ended without completing."
          : `Firecrawl crawl persisted ${resultCount} deduplicated page${resultCount === 1 ? "" : "s"}.`,
      });
    }
    return { jobId: job._id, resultCount };
  }
}

export const crawlCompleted = internalMutation({
  args: {
    crawlId: v.string(),
    jobId: v.optional(v.string()),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    pageCount: v.number(),
    unstored: v.optional(v.number()),
    error: v.optional(v.string()),
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = (args.context ?? {}) as { missionId?: string; jobId?: string };
    if (!context.missionId || !context.jobId) return null;
    await completeCrawl(ctx, {
      jobId: context.jobId as Id<"researchJobs">,
      missionId: context.missionId as Id<"missions">,
      crawlId: args.crawlId,
      crawlStatus: args.status,
      pageCount: args.pageCount,
      error: args.error ?? null,
      pages: [],
    });
    return null;
  },
});

export const failJob = internalMutation({
  args: { jobId: v.id("researchJobs"), errorSummary: v.string() },
  returns: v.id("researchJobs"),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Research job not found.");
    const now = Date.now();
    await ctx.db.patch(job._id, { status: "failed", errorSummary: bounded(args.errorSummary, 240), finishedAt: now, updatedAt: now });
    const run = await ctx.db.get(job.runId);
    if (run && !["complete", "failed", "cancelled"].includes(run.status)) {
      await transitionRun(ctx, {
        missionId: job.missionId,
        targetStage: run.currentStage,
        targetStatus: "failed",
        interruption: "Firecrawl research failed. Retry after reviewing the error.",
        eventType: "source.failed",
        safeSummary: "Firecrawl research failed; no side effect was attempted.",
      });
    }
    return job._id;
  },
});

export const sourceForScrape = internalQuery({
  args: { missionId: v.id("missions"), sourceId: v.id("sourceRecords") },
  returns: v.union(v.object({ _id: v.id("sourceRecords"), url: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    return source && source.missionId === args.missionId ? { _id: source._id, url: source.url } : null;
  },
});

export const markSourceScraping = internalMutation({
  args: { sourceId: v.id("sourceRecords") },
  returns: v.id("sourceRecords"),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("Source not found.");
    await ctx.db.patch(source._id, { processingStatus: "scraping", errorSummary: null, updatedAt: Date.now() });
    return source._id;
  },
});

export const markSourceFailed = internalMutation({
  args: { sourceId: v.id("sourceRecords"), errorSummary: v.string() },
  returns: v.id("sourceRecords"),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error("Source not found.");
    await ctx.db.patch(source._id, { processingStatus: "failed", errorSummary: bounded(args.errorSummary, 240), updatedAt: Date.now() });
    return source._id;
  },
});

const jobView = v.object({
  _id: v.id("researchJobs"),
  missionId: v.id("missions"),
  runId: v.id("agentRuns"),
  requestId: v.string(),
  operation: researchOperation,
  query: v.string(),
  status: researchJobStatus,
  provider: v.literal("firecrawl"),
  providerRequestId: v.union(v.string(), v.null()),
  resultCount: v.number(),
  crawlId: v.union(v.string(), v.null()),
  crawlStatus: v.union(crawlStatus, v.null()),
  errorSummary: v.union(v.string(), v.null()),
  createdAt: v.number(),
  startedAt: v.number(),
  finishedAt: v.union(v.number(), v.null()),
  updatedAt: v.number(),
});

const sourceView = v.object({
  _id: v.id("sourceRecords"),
  missionId: v.id("missions"),
  jobId: v.id("researchJobs"),
  url: v.string(),
  title: v.string(),
  sourceType,
  excerpt: v.string(),
  content: v.union(v.string(), v.null()),
  fetchedAt: v.number(),
  freshness: v.string(),
  firecrawlRequestId: v.union(v.string(), v.null()),
  firecrawlPageId: v.union(v.string(), v.null()),
  processingStatus: sourceProcessingStatus,
  errorSummary: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const matchView = v.object({
  _id: v.id("matches"),
  missionId: v.id("missions"),
  discoveryId: v.id("discoveries"),
  sourceId: v.id("sourceRecords"),
  label: matchLabel,
  positiveEvidence: v.array(v.string()),
  unknowns: v.array(v.string()),
  risks: v.array(v.string()),        freshness: v.string(),
        recommendedAction: v.string(),
        explanationSummary: v.union(v.string(), v.null()),
        explanationModel: v.union(v.string(), v.null()),
        subject: v.string(),
  signal: v.string(),
  sourceUrl: v.string(),
  sourceTitle: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const saveExplanations = internalMutation({
  args: { explanations: v.array(explanationInput) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const now = Date.now();
    let saved = 0;
    for (const item of args.explanations) {
      const match = await ctx.db.get(item.matchId);
      if (!match) continue;
      await ctx.db.patch(match._id, {
        label: item.label,
        positiveEvidence: item.positiveEvidence.map((line) => bounded(line, 300)).slice(0, 8),
        unknowns: item.unknowns.map((line) => bounded(line, 300)).slice(0, 8),
        risks: item.risks.map((line) => bounded(line, 300)).slice(0, 8),
        recommendedAction: bounded(item.recommendedAction, 300),
        explanationSummary: bounded(item.summary, 600),
        explanationProvider: item.provider,
        explanationModel: item.model,
        explainedAt: now,
        updatedAt: now,
      });
      saved += 1;
    }
    return saved;
  },
});

export const missionForExplanation = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.union(v.object({
    _id: v.id("missions"),
    rawGoal: v.string(),
    mode: v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator")),
    mustHave: v.array(v.string()),
    normalizedGoal: v.string(),
    completionPredicate: v.string(),
  }), v.null()),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) return null;
    const plan = await ctx.db.query("missionPlans")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .first();
    return {
      _id: mission._id,
      rawGoal: mission.rawGoal,
      mode: mission.mode,
      mustHave: plan?.mustHave ?? [],
      normalizedGoal: plan?.normalizedGoal ?? mission.rawGoal,
      completionPredicate: plan?.completionPredicate ?? mission.completionPredicate,
    };
  },
});

export const evidenceForExplanation = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({
    matchId: v.id("matches"),
    subject: v.string(),
    sourceUrl: v.string(),
    sourceType: v.string(),
    currentLabel: matchLabel,
    excerpt: v.string(),
    content: v.union(v.string(), v.null()),
    fetchedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const matches = await ctx.db.query("matches")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .take(20);
    const result = [];
    for (const match of matches) {
      const [discovery, source] = await Promise.all([ctx.db.get(match.discoveryId), ctx.db.get(match.sourceId)]);
      if (!discovery || !source) continue;
      result.push({
        matchId: match._id,
        subject: discovery.subject,
        sourceUrl: source.url,
        sourceType: source.sourceType,
        currentLabel: match.label,
        excerpt: bounded(discovery.signal || source.excerpt, 500),
        content: source.content ? bounded(source.content, 4000) : null,
        fetchedAt: source.fetchedAt,
      });
    }
    return result;
  },
});

export const listJobs = query({
  args: { missionId: v.id("missions") },
  returns: v.array(jobView),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("researchJobs")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    return jobs.map(({ _creationTime, ...job }) => job);
  },
});

export const listSources = query({
  args: { missionId: v.id("missions") },
  returns: v.array(sourceView),
  handler: async (ctx, args) => {
    const sources = await ctx.db.query("sourceRecords")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(100);
    return sources.map(({ _creationTime, ...source }) => source);
  },
});

export const listMatches = query({
  args: { missionId: v.id("missions") },
  returns: v.array(matchView),
  handler: async (ctx, args) => {
    const matches = await ctx.db.query("matches")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(100);
    const result = [];
    for (const match of matches) {
      const [discovery, source] = await Promise.all([ctx.db.get(match.discoveryId), ctx.db.get(match.sourceId)]);
      if (!discovery || !source) continue;
      result.push({
        _id: match._id,
        missionId: match.missionId,
        discoveryId: match.discoveryId,
        sourceId: match.sourceId,
        label: match.label,
        positiveEvidence: match.positiveEvidence,
        unknowns: match.unknowns,
        risks: match.risks,
        freshness: match.freshness,
        recommendedAction: match.recommendedAction,
        explanationSummary: match.explanationSummary ?? null,
        explanationModel: match.explanationModel ?? null,
        subject: discovery.subject,
        signal: discovery.signal,
        sourceUrl: source.url,
        sourceTitle: source.title,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
      });
    }
    return result;
  },
});
