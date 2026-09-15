"use node";

import { v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";

const firecrawl = new FirecrawlClient(components.firecrawl);

const researchJobStatus = v.union(v.literal("running"), v.literal("complete"), v.literal("failed"));
type ResearchJobStatus = "running" | "complete" | "failed";

export const search = action({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.object({ jobId: v.id("researchJobs"), resultCount: v.number(), status: researchJobStatus }),
  handler: async (ctx, args): Promise<{ jobId: any; resultCount: number; status: ResearchJobStatus }> => {
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
      const response = await firecrawl.search(ctx, args.query.trim(), {
        limit,
        timeout: 60000,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true, timeout: 30000 },
      });
      const normalized = normalizeSearchResults(response, args.requestId);
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
  handler: async (ctx, args): Promise<{ jobId: any; sourceId: any; status: ResearchJobStatus }> => {
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
      const document = await firecrawl.scrape(ctx, source.url, {
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: true,
      });
      const normalized = normalizeScrapeResult(document, source.url, args.requestId);
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

export const mapSite = action({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    url: v.string(),
    limit: v.number(),
  },
  returns: v.object({ jobId: v.id("researchJobs"), linkCount: v.number(), status: researchJobStatus }),
  handler: async (ctx, args): Promise<{ jobId: any; linkCount: number; status: ResearchJobStatus }> => {
    const trimmed = args.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("INVALID_ARGUMENT: url must be an absolute http(s) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("INVALID_ARGUMENT: url must use http or https.");
    }
    const started = await ctx.runMutation(internal.researchStore.startJob, {
      missionId: args.missionId,
      requestId: args.requestId,
      operation: "map",
      query: trimmed,
    });
    if (!started.shouldExecute) {
      return { jobId: started.jobId, linkCount: started.resultCount, status: started.status };
    }
    try {
      const result = await firecrawl.map(ctx, trimmed, { limit: Math.max(1, Math.min(200, Math.floor(args.limit))) });
      const links = (result.links ?? [])
        .map((link) => link.url)
        .filter((url): url is string => typeof url === "string")
        .slice(0, 50);
      const finished = await ctx.runMutation(internal.researchStore.finishJob, {
        jobId: started.jobId,
        providerRequestId: result.id ?? null,
        sources: links.map((url) => ({
          url,
          title: hostOf(url),
          sourceType: "mapped_site" as const,
          excerpt: "Site structure discovered through a Firecrawl map of this domain.",
          content: null,
          freshness: "fresh",
          firecrawlRequestId: result.id ?? null,
          firecrawlPageId: null,
          processingStatus: "discovered" as const,
          label: "uncertain" as const,
        })),
      });
      return { jobId: finished.jobId, linkCount: finished.resultCount, status: "complete" as const };
    } catch (error) {
      await ctx.runMutation(internal.researchStore.failJob, {
        jobId: started.jobId,
        errorSummary: error instanceof Error ? error.message : "Firecrawl map failed.",
      });
      throw error;
    }
  },
});

export const startCrawl = action({
  args: {
    missionId: v.id("missions"),
    requestId: v.string(),
    url: v.string(),
    limit: v.number(),
  },
  returns: v.object({ jobId: v.id("researchJobs"), crawlId: v.string(), status: researchJobStatus }),
  handler: async (ctx, args): Promise<{ jobId: any; crawlId: string; status: ResearchJobStatus }> => {
    const trimmed = args.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("INVALID_ARGUMENT: url must be an absolute http(s) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("INVALID_ARGUMENT: url must use http or https.");
    }
    const started = await ctx.runMutation(internal.researchStore.startCrawlJob, {
      missionId: args.missionId,
      requestId: args.requestId,
      url: trimmed,
    });
    if (!started.shouldExecute) {
      return { jobId: started.jobId, crawlId: started.crawlId ?? "", status: started.status };
    }
    try {
      const { crawlId, jobId: firecrawlJobId } = await firecrawl.startCrawl(ctx, {
        url: trimmed,
        options: {
          limit: Math.max(1, Math.min(30, Math.floor(args.limit))),
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
          allowSubdomains: false,
          deduplicateSimilarURLs: true,
        },
        storeContent: true,
        onComplete: internal.researchStore.crawlCompleted,
        context: { missionId: args.missionId, jobId: started.jobId },
      });
      await ctx.runMutation(internal.researchStore.attachCrawl, {
        jobId: started.jobId,
        crawlId,
        firecrawlJobId,
      });
      return { jobId: started.jobId, crawlId, status: "running" as const };
    } catch (error) {
      await ctx.runMutation(internal.researchStore.failJob, {
        jobId: started.jobId,
        errorSummary: error instanceof Error ? error.message : "Firecrawl crawl failed to start.",
      });
      throw error;
    }
  },
});

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function bounded(value: string, length: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

type NormalizedSource = {
  url: string;
  title: string;
  sourceType: "search_result" | "scraped_page";
  excerpt: string;
  content: string | null;
  freshness: string;
  firecrawlRequestId: string | null;
  firecrawlPageId: string | null;
  processingStatus: "discovered" | "scraping" | "scraped" | "failed";
  label: "stronger" | "promising" | "uncertain" | "insufficient";
};

function normalizeSearchResults(response: unknown, requestId: string) {
  const items = isRecord(response) && Array.isArray(response.web) ? response.web.filter(isRecord) : [];
  const results: NormalizedSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = normalizedUrl(typeof item.url === "string" ? item.url : "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = bounded(typeof item.title === "string" && item.title.trim() ? item.title : hostOf(url), 180);
    const markdown = bounded(typeof item.markdown === "string" ? item.markdown : "", 12000);
    const excerpt = bounded(
      typeof item.description === "string" && item.description.trim()
        ? item.description
        : typeof item.snippet === "string" ? item.snippet : markdown,
      500,
    );
    const content = markdown || null;
    results.push({
      url,
      title,
      sourceType: "search_result",
      excerpt: excerpt || "Firecrawl returned this public-web result without a description.",
      content,
      freshness: "fresh",
      firecrawlRequestId: requestId,
      firecrawlPageId: null,
      processingStatus: content ? "scraped" : "discovered",
      label: content || excerpt ? "promising" : "uncertain",
    });
  }
  return { providerRequestId: requestId || null, results };
}

function normalizeScrapeResult(document: unknown, sourceUrl: string, requestId: string) {
  const doc = isRecord(document) ? document : {};
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  const content = bounded(typeof doc.markdown === "string" ? doc.markdown : "", 12000);
  const title = bounded(
    typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : hostOf(sourceUrl),
    180,
  );
  const excerpt = bounded(typeof doc.summary === "string" && doc.summary ? doc.summary : content, 500);
  return {
    url: normalizedUrl(sourceUrl) ?? sourceUrl,
    title,
    sourceType: "scraped_page" as const,
    excerpt: excerpt || "Firecrawl returned a page without a text summary.",
    content: content || null,
    freshness: "fresh",
    firecrawlRequestId: requestId || null,
    firecrawlPageId: typeof metadata.pageId === "string" ? metadata.pageId : null,      processingStatus: content ? ("scraped" as const) : ("failed" as const),
      label: content ? ("promising" as const) : ("insufficient" as const),
  };
}
