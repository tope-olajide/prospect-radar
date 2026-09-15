"use node";

import process from "node:process";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const researchJobStatus = v.union(v.literal("running"), v.literal("complete"), v.literal("failed"));
type ResearchJobStatus = "running" | "complete" | "failed";

function safeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summaryForError(status: number, payload: unknown) {
  if (status === 429) return "Firecrawl rate limit reached. Retry later.";
  if (status === 402) return "Firecrawl credits are exhausted for this deployment.";
  if (status >= 500) return "Firecrawl is temporarily unavailable. Retry later.";
  const code = isRecord(payload) ? safeText(payload.code) : "";
  return code ? `Firecrawl rejected the request (${code}).` : `Firecrawl rejected the request (${status}).`;
}

function resultItems(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.data)) return [] as Record<string, unknown>[];
  const data = payload.data;
  const web = Array.isArray(data.web) ? data.web : [];
  const news = Array.isArray(data.news) ? data.news : [];
  return [...web, ...news].filter(isRecord);
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

function normalizeSearchResults(payload: unknown, requestId: string) {
  const providerRequestId = isRecord(payload) ? safeText(payload.id, requestId) : requestId;
  const results: Array<{
    url: string;
    title: string;
    sourceType: "search_result";
    excerpt: string;
    content: string | null;
    freshness: string;
    firecrawlRequestId: string | null;
    firecrawlPageId: string | null;
    processingStatus: "discovered" | "scraping" | "scraped" | "failed";
    label: "stronger" | "promising" | "uncertain" | "insufficient";
  }> = [];
  const seen = new Set<string>();

  for (const item of resultItems(payload)) {
    const url = normalizedUrl(safeText(item.url));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = bounded(safeText(item.title, new URL(url).hostname), 180);
    const markdown = bounded(safeText(item.markdown), 12000);
    const excerpt = bounded(safeText(item.description, safeText(item.snippet, markdown)), 500);
    const content = markdown || null;
    results.push({
      url,
      title,
      sourceType: "search_result",
      excerpt: excerpt || "Firecrawl returned this public-web result without a description.",
      content,
      freshness: "fresh",
      firecrawlRequestId: providerRequestId || null,
      firecrawlPageId: null,
      processingStatus: content ? "scraped" : "discovered",
      label: content || excerpt ? "promising" : "uncertain",
    });
  }
  return { providerRequestId: providerRequestId || null, results };
}

function normalizeScrapeResult(payload: unknown, sourceUrl: string, requestId: string) {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const content = bounded(safeText(data.markdown), 12000);
  const title = bounded(safeText(metadata.title, new URL(sourceUrl).hostname), 180);
  const excerpt = bounded(safeText(data.summary, content), 500);
  const providerRequestId = isRecord(payload) ? safeText(payload.id, requestId) : requestId;
  return {
    url: normalizedUrl(sourceUrl) ?? sourceUrl,
    title,
    sourceType: "scraped_page" as const,
    excerpt: excerpt || "Firecrawl returned a page without a text summary.",
    content: content || null,
    freshness: "fresh",
    firecrawlRequestId: providerRequestId || null,
    firecrawlPageId: safeText(metadata.pageId) || null,
    processingStatus: content ? "scraped" as const : "failed" as const,
    label: content ? "promising" as const : "insufficient" as const,
  };
}

function bounded(value: string, length: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

async function firecrawlRequest(path: string, body: Record<string, unknown>) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured on this Convex deployment.");
  const response = await fetch(`https://api.firecrawl.dev/v2/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (isRecord(payload) && payload.success === false)) {
    throw new Error(summaryForError(response.status, payload));
  }
  return payload;
}

export const search = action({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.object({ jobId: v.id("researchJobs"), resultCount: v.number(), status: researchJobStatus }),
  handler: async (ctx, args): Promise<{ jobId: Id<"researchJobs">; resultCount: number; status: ResearchJobStatus }> => {
    const limit = Math.max(1, Math.min(10, Math.floor(args.limit)));
    const started = await ctx.runMutation(internal.researchStore.startJob, {
      missionId: args.missionId,
      requestId: args.requestId,
      operation: "search",
      query: args.query.trim(),
    });
    if (!started.shouldExecute) {
      return { jobId: started.jobId, resultCount: started.resultCount, status: started.status };
    }
    try {
      const payload = await firecrawlRequest("search", {
        query: args.query.trim(),
        limit,
        sources: ["web"],
        safe: true,
        highlights: true,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      });
      const normalized = normalizeSearchResults(payload, args.requestId);
      const finished = await ctx.runMutation(internal.researchStore.finishJob, {
        jobId: started.jobId,
        providerRequestId: normalized.providerRequestId,
        sources: normalized.results,
      });
      return { jobId: finished.jobId, resultCount: finished.resultCount, status: "complete" as const };
    } catch (error) {
      await ctx.runMutation(internal.researchStore.failJob, {
        jobId: started.jobId,
        errorSummary: error instanceof Error ? error.message : "Firecrawl search failed.",
      });
      throw error;
    }
  },
});

export const scrape = action({
  args: {
    missionId: v.id("missions"),
    sourceId: v.id("sourceRecords"),
    requestId: v.string(),
  },
  returns: v.object({ jobId: v.id("researchJobs"), sourceId: v.id("sourceRecords"), status: researchJobStatus }),
  handler: async (ctx, args): Promise<{ jobId: Id<"researchJobs">; sourceId: Id<"sourceRecords">; status: ResearchJobStatus }> => {
    const source = await ctx.runQuery(internal.researchStore.sourceForScrape, {
      missionId: args.missionId,
      sourceId: args.sourceId,
    });
    if (!source) throw new Error("Source not found for this mission.");
    const started = await ctx.runMutation(internal.researchStore.startJob, {
      missionId: args.missionId,
      requestId: args.requestId,
      operation: "scrape",
      query: source.url,
    });
    if (!started.shouldExecute) {
      return { jobId: started.jobId, sourceId: args.sourceId, status: started.status };
    }
    try {
      await ctx.runMutation(internal.researchStore.markSourceScraping, { sourceId: args.sourceId });
      const payload = await firecrawlRequest("scrape", {
        url: source.url,
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: true,
      });
      const normalized = normalizeScrapeResult(payload, source.url, args.requestId);
      const finished = await ctx.runMutation(internal.researchStore.finishJob, {
        jobId: started.jobId,
        providerRequestId: normalized.firecrawlRequestId,
        sources: [normalized],
      });
      return { jobId: finished.jobId, sourceId: args.sourceId, status: "complete" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Firecrawl scrape failed.";
      await ctx.runMutation(internal.researchStore.markSourceFailed, { sourceId: args.sourceId, errorSummary: message });
      await ctx.runMutation(internal.researchStore.failJob, { jobId: started.jobId, errorSummary: message });
      throw error;
    }
  },
});
