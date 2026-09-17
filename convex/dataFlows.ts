import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { boundedText } from "./hash";

/**
 * Data-source ingest actions: the Firecrawl side of user-supplied sources.
 *
 * Website sources sync through the same durable machinery the mission pipeline
 * uses: `startCrawl` (component-owned, webhook-driven) with a completion
 * callback that reads the stored pages back via `crawl.listPages` and hands
 * them to `dataSources.ingestWebsitePages` for chunking. "single" mode scrapes
 * one page synchronously in this action. Firecrawl billing already meters the
 * component; the workspace budget ledger is mission-scoped by design, so
 * source syncs are bounded by page limit instead.
 */

const firecrawl = new FirecrawlClient(components.firecrawl);

/** Site sync budget: enough to capture a real site, cheap enough to re-run. */
export const SYNC_PAGE_LIMIT = 25;

function normalizeMarkdown(raw: string, maxChars = 8000): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links to their text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

/** Scrape just the landing page and ingest it. Used by "single" mode. */
export const syncSinglePage = internalAction({
  args: { sourceId: v.id("dataSources"), workspaceId: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const document = await firecrawl.scrape(ctx, args.url, {
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: true,
      });
      const markdown = typeof document?.markdown === "string" ? document.markdown : "";
      const pageUrl = typeof document?.metadata?.sourceURL === "string" ? document.metadata.sourceURL : args.url;
      const title = boundedText(
        typeof document?.metadata?.title === "string" && document.metadata.title ? document.metadata.title : args.url,
        200,
      );
      await ctx.runMutation(internal.dataSources.ingestWebsitePages, {
        workspaceId: args.workspaceId,
        sourceId: args.sourceId,
        crawlId: null,
        pages: markdown.trim() ? [{ url: pageUrl, title, content: normalizeMarkdown(markdown) }] : [],
        failed: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The website could not be synced.";
      await ctx.runMutation(internal.dataSources.markSyncFailed, { sourceId: args.sourceId, error: message });
    }
  },
});

/** Start the durable multi-page crawl for a website source. */
export const startWebsiteCrawl = internalAction({
  args: {
    sourceId: v.id("dataSources"),
    workspaceId: v.string(),
    url: v.string(),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap")),
    includePaths: v.optional(v.array(v.string())),
    excludePaths: v.optional(v.array(v.string())),
    pageLimit: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(SYNC_PAGE_LIMIT, args.pageLimit ?? SYNC_PAGE_LIMIT));
    try {
      const { crawlId } = await firecrawl.startCrawl(ctx, {
        url: args.url,
        options: {
          limit,
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true, removeBase64Images: true, blockAds: true },
          allowSubdomains: false,
          deduplicateSimilarURLs: true,
          ...(args.crawlMode === "sitemap" ? { sitemap: "only" as const } : {}),
          ...(args.includePaths && args.includePaths.length > 0 ? { includePaths: args.includePaths } : {}),
          ...(args.excludePaths && args.excludePaths.length > 0 ? { excludePaths: args.excludePaths } : {}),
        },
        storeContent: true,
        onComplete: internal.dataFlows.websiteCrawlCompleted,
        context: { sourceId: args.sourceId, workspaceId: args.workspaceId },
      });
      await ctx.runMutation(internal.dataSources.attachCrawl, { sourceId: args.sourceId, crawlId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The website could not be synced.";
      await ctx.runMutation(internal.dataSources.markSyncFailed, { sourceId: args.sourceId, error: message });
    }
  },
});

/**
 * Completion callback for a website-source crawl. Reads the stored pages back
 * from the component and ingests them. Failed crawls keep any previously
 * synced content (ingestWebsitePages decides) and surface the error.
 */
export const websiteCrawlCompleted = internalMutation({
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
    const context = (args.context ?? {}) as { sourceId?: string; workspaceId?: string };
    if (!context.sourceId || !context.workspaceId) return null;
    if (args.status !== "completed") {
      await ctx.runMutation(internal.dataSources.ingestWebsitePages, {
        workspaceId: context.workspaceId,
        sourceId: context.sourceId as Id<"dataSources">,
        crawlId: args.crawlId,
        pages: [],
        failed: true,
        error: args.error ?? `The website sync ended with status ${args.status}.`,
      });
      return null;
    }
    // Read the stored pages back out of the component, cursor-bounded.
    const pages: Array<{ url: string; title: string; content: string }> = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 10; hop += 1) {
      const page: { page: Array<{ url: string; markdown?: string | undefined; metadata?: any }>; continueCursor: string; isDone: boolean } = await ctx.runQuery(components.firecrawl.crawl.listPages, {
        crawlId: args.crawlId,
        paginationOpts: { numItems: 25, cursor, maximumRowsRead: 200 },
      });
      for (const row of page.page) {
        const markdown = typeof row.markdown === "string" ? row.markdown : "";
        if (!markdown.trim() || !row.url) continue;
        const title = boundedText(
          typeof row.metadata?.title === "string" && row.metadata.title ? row.metadata.title : row.url,
          200,
        );
        pages.push({ url: row.url, title, content: normalizeMarkdown(markdown) });
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    await ctx.runMutation(internal.dataSources.ingestWebsitePages, {
      workspaceId: context.workspaceId,
      sourceId: context.sourceId as Id<"dataSources">,
      crawlId: args.crawlId,
      pages,
      failed: false,
    });
    return null;
  },
});

/**
 * Auto-resync sweep: re-sync website sources whose last successful sync is
 * older than the cadence. Scheduled daily by crons.ts.
 */
/** Manual resync of one source, requested from the Data sources page. */
export const resyncSource = action({
  args: { workspaceId: v.string(), sourceId: v.id("dataSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.runQuery(internal.dataSources.getForSync, { sourceId: args.sourceId });
    if (!source || source.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: source is not in this workspace.");
    }
    if (source.status === "syncing") return null;
    if (!source.url) throw new Error("INVALID_ARGUMENT: this source has no website URL to resync.");
    if (source.crawlMode === "single") {
      await ctx.runAction(internal.dataFlows.syncSinglePage, {
        sourceId: args.sourceId,
        workspaceId: args.workspaceId,
        url: source.url,
      });
    } else {
      await ctx.runAction(internal.dataFlows.startWebsiteCrawl, {
        sourceId: args.sourceId,
        workspaceId: args.workspaceId,
        url: source.url,
        crawlMode: source.crawlMode === "sitemap" ? "sitemap" : "crawl",
      });
    }
    return null;
  },
});

export const resyncSweep = internalAction({
  args: { olderThanMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cadence = args.olderThanMs ?? 24 * 60 * 60 * 1000;
    const stale = await ctx.runQuery(internal.dataSources.staleWebsites, { olderThanMs: cadence });
    for (const source of stale) {
      if (source.crawlMode === "single") {
        await ctx.runAction(internal.dataFlows.syncSinglePage, {
          sourceId: source.sourceId,
          workspaceId: source.workspaceId,
          url: source.url,
        });
      } else {
        await ctx.runAction(internal.dataFlows.startWebsiteCrawl, {
          sourceId: source.sourceId,
          workspaceId: source.workspaceId,
          url: source.url,
          crawlMode: source.crawlMode,
        });
      }
    }
    return null;
  },
});
