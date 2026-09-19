import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { boundedText } from "./hash";
import { chunkText, documentSummary, toSearchText } from "./dataSourceText";
import { validateWorkspace } from "./model/auth";

/**
 * User-supplied data sources: the user's side of the evidence ledger.
 *
 * The public web tells Radar what the world wants; these sources tell it what
 * the user offers. A freelancer's portfolio, a company's product one-pager, a
 * job seeker's résumé — uploaded once, chunked, and then pulled into whichever
 * mission needs them. Content lives in bounded chunks; prompts never receive a
 * whole document.
 */

const SOURCE_TITLE_MAX = 120;
const SNIPPET_MAX = 20_000;

/** How many of a workspace's chunks a readiness check may scan. */
const EVIDENCE_CHUNK_LIMIT = 200;

/**
 * Retrieval: the mission-relevant chunks of the user's own sources.
 *
 * Convex's full-text search ranks chunk rows against the mission's goal text;
 * relevance ties break by source recency, so a fresh portfolio outranks a
 * stale one when both mention the same skill. Bounded to five chunks so a
 * prompt's profile section stays small even with many sources.
 */
export const relevantChunks = internalQuery({
  args: { workspaceId: v.string(), query: v.string() },
  returns: v.array(v.object({ title: v.string(), kind: v.string(), text: v.string() })),
  handler: async (ctx, args) => {
    const trimmed = args.query.trim();
    if (!trimmed) return [];
    // The full-text index is the ranked path. If it is unavailable, fall back to
    // a bounded scan that keeps any chunk mentioning a goal term, so a missing
    // index degrades retrieval rather than failing the caller that asked for
    // context (the outreach draft path cannot do its job without it).
    let rows: Array<{ sourceId: Id<"dataSources">; text: string; _creationTime: number }> = [];
    try {
      rows = await ctx.db
        .query("dataSourceChunks")
        .withSearchIndex("search_text", (q) => q.search("searchText", trimmed).eq("workspaceId", args.workspaceId))
        .take(12);
    } catch {
      const probe = [...new Set(trimmed.toLowerCase().split(/\s+/).filter((word) => word.length >= 4))];
      const scanned = await ctx.db
        .query("dataSourceChunks")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .take(EVIDENCE_CHUNK_LIMIT);
      rows = scanned
        .filter((chunk) => probe.length === 0 || probe.some((word) => chunk.text.toLowerCase().includes(word)))
        .slice(0, 12);
    }
    if (rows.length === 0) return [];
    const sources = new Map(
      (await Promise.all([...new Set(rows.map((r) => r.sourceId))].map((id) => ctx.db.get(id))))
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => [s._id, s]),
    );
    const decorated: Array<{ title: string; kind: string; text: string; rank: number }> = [];
    for (const row of rows) {
      const source = sources.get(row.sourceId);
      if (!source) continue;
      decorated.push({ title: source.title, kind: source.kind, text: boundedText(row.text, 400), rank: row._creationTime });
    }
    return decorated
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 5)
      .map(({ title, kind, text }) => ({ title, kind, text }));
  },
});

/**
 * Deterministic evidence scan for the context-readiness resolver.
 *
 * `relevantChunks` ranks one query against the full-text index, which is the
 * right tool for a mission goal. Readiness is a different question: it asks
 * "does any of this user's own material mention X?" for several requirements at
 * once, and it must be able to see the sentence *around* a match — a negation
 * ("no React") or an exclusivity marker ("only contract work") is what turns a
 * mention into a conflict. So this reads a bounded slice of the workspace's
 * chunks once and returns matched excerpts, tagged with the probe term that
 * found them and the source they came from.
 *
 * Terms arrive in priority order; the first term to hit a chunk claims it, so
 * the caller's most specific probe wins. Bounded on both axes (chunks read and
 * excerpt length) because a workspace with many sources must not make a
 * readiness check unbounded.
 */
export const evidenceForTerms = internalQuery({
  args: { workspaceId: v.string(), terms: v.array(v.string()) },
  returns: v.array(v.object({
    term: v.string(),
    sourceId: v.id("dataSources"),
    title: v.string(),
    kind: v.string(),
    excerpt: v.string(),
  })),
  handler: async (ctx, args) => {
    const needles = [...new Set(args.terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (needles.length === 0) return [];

    const chunks = await ctx.db
      .query("dataSourceChunks")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(EVIDENCE_CHUNK_LIMIT);
    if (chunks.length === 0) return [];

    const matches: Array<{ term: string; sourceId: Id<"dataSources">; start: number; text: string }> = [];
    for (const chunk of chunks) {
      const haystack = chunk.text.toLowerCase();
      for (const needle of needles) {
        const at = haystack.indexOf(needle);
        if (at === -1) continue;
        matches.push({ term: needle, sourceId: chunk.sourceId, start: at, text: chunk.text });
        break; // one probe per chunk keeps the result bounded
      }
    }
    if (matches.length === 0) return [];

    const sources = new Map(
      (await Promise.all([...new Set(matches.map((m) => m.sourceId))].map((id) => ctx.db.get(id))))
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => [s._id, s]),
    );

    const out: Array<{ term: string; sourceId: Id<"dataSources">; title: string; kind: string; excerpt: string }> = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const source = sources.get(match.sourceId);
      if (!source || source.status === "archived") continue;
      const key = `${match.sourceId}:${match.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        term: match.term,
        sourceId: match.sourceId,
        title: source.title,
        kind: source.kind,
        // The window around the hit carries the negation/exclusivity signal.
        excerpt: boundedText(match.text.slice(Math.max(0, match.start - 90), match.start + 170), 260),
      });
    }
    return out;
  },
});

/** Everything the source list row needs — no document bodies. */
export const list = query({
  args: { workspaceId: v.string() },
  returns: v.array(v.object({
    _id: v.id("dataSources"),
    kind: v.union(v.literal("file"), v.literal("website"), v.literal("snippet")),
    title: v.string(),
    summary: v.string(),
    url: v.union(v.string(), v.null()),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single")),
    status: v.union(v.literal("syncing"), v.literal("ready"), v.literal("failed"), v.literal("archived")),
    chunkCount: v.number(),
    pageCount: v.number(),
    lastSyncedAt: v.union(v.number(), v.null()),
    syncError: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("dataSources")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(100);
    const out = [];
    for (const row of rows) {
      const chunkCount =
        row.status === "archived"
          ? 0
          : (
            await ctx.db
              .query("dataSourceChunks")
              .withIndex("by_sourceId", (q) => q.eq("sourceId", row._id))
              .take(500)
          ).length;
      out.push({
        _id: row._id,
        kind: row.kind,
        title: row.title,
        summary: row.kind === "website" ? row.url ?? "" : documentSummary(row.text ?? "", 140),
        url: row.url,
        crawlMode: row.crawlMode,
        status: row.status,
        chunkCount,
        pageCount: row.pageCount,
        lastSyncedAt: row.lastSyncedAt,
        syncError: row.syncError,
        createdAt: row.createdAt,
      });
    }
    return out;
  },
});

/** One source with its chunk preview, for the detail drawer. */
export const get = query({
  args: { workspaceId: v.string(), sourceId: v.id("dataSources") },
  returns: v.union(v.object({
    _id: v.id("dataSources"),
    kind: v.union(v.literal("file"), v.literal("website"), v.literal("snippet")),
    title: v.string(),
    url: v.union(v.string(), v.null()),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single")),
    status: v.union(v.literal("syncing"), v.literal("ready"), v.literal("failed"), v.literal("archived")),
    pageCount: v.number(),
    lastSyncedAt: v.union(v.number(), v.null()),
    syncError: v.union(v.string(), v.null()),
    preview: v.array(v.string()),
    createdAt: v.number(),
  }), v.null()),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const row = await ctx.db.get(args.sourceId);
    if (!row || row.workspaceId !== args.workspaceId) return null;
    const chunks = await ctx.db
      .query("dataSourceChunks")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", row._id))
      .take(3);
    return {
      _id: row._id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      crawlMode: row.crawlMode,
      status: row.status,
      pageCount: row.pageCount,
      lastSyncedAt: row.lastSyncedAt,
      syncError: row.syncError,
      preview: chunks.map((chunk) => chunk.text.slice(0, 280)),
      createdAt: row.createdAt,
    };
  },
});

async function insertChunks(ctx: { db: any }, workspaceId: string, sourceId: Id<"dataSources">, text: string) {
  const chunks = chunkText(text);
  let ordinal = 0;
  for (const chunk of chunks) {
    await ctx.db.insert("dataSourceChunks", {
      workspaceId,
      sourceId,
      ordinal,
      text: chunk,
      searchText: toSearchText(chunk),
    });
    ordinal += 1;
  }
  return chunks.length;
}

async function clearChunks(ctx: MutationCtx, sourceId: Id<"dataSources">) {
  const existing = await ctx.db
    .query("dataSourceChunks")
    .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
    .take(200);
  for (const chunk of existing) await ctx.db.delete(chunk._id);
}

/** A pasted text snippet — the fastest way to tell Radar what you offer. */
export const addSnippet = mutation({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    text: v.string(),
  },
  returns: v.id("dataSources"),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const title = boundedText(args.title, SOURCE_TITLE_MAX) || "Untitled snippet";
    if (args.text.length > SNIPPET_MAX) {
      throw new Error(`INVALID_ARGUMENT: snippets are limited to ${SNIPPET_MAX} characters — this one is ${args.text.length}.`);
    }
    const text = boundedText(args.text, SNIPPET_MAX);
    if (!text || text.length < 10) throw new Error("INVALID_ARGUMENT: the snippet needs at least 10 characters of text.");
    const now = Date.now();
    const sourceId = await ctx.db.insert("dataSources", {
      workspaceId: args.workspaceId,
      kind: "snippet",
      title,
      url: null,
      crawlMode: "single",
      crawlId: null,
      fileId: null,
      text,
      status: "ready",
      pageCount: 0,
      lastSyncedAt: now,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
    const chunkCount = await insertChunks(ctx, args.workspaceId, sourceId, text);
    await ctx.db.patch(sourceId, { updatedAt: now });
    return sourceId;
  },
});

/**
 * File upload, step 1: register the source and return the storage upload URL.
 * The client POSTs the file bytes there, then calls `fileReady` with the
 * storage id so the text extraction + chunking runs server-side.
 */
export const addFile = mutation({
  args: { workspaceId: v.string(), title: v.string(), sizeBytes: v.number() },
  returns: v.object({ sourceId: v.id("dataSources"), uploadUrl: v.string() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    if (args.sizeBytes <= 0 || args.sizeBytes > 20 * 1024 * 1024) {
      throw new Error("INVALID_ARGUMENT: files must be between 1 byte and 20 MB.");
    }
    const title = boundedText(args.title, SOURCE_TITLE_MAX) || "Untitled file";
    const now = Date.now();
    const sourceId = await ctx.db.insert("dataSources", {
      workspaceId: args.workspaceId,
      kind: "file",
      title,
      url: null,
      crawlMode: "single",
      crawlId: null,
      fileId: null,
      text: null,
      status: "syncing",
      pageCount: 0,
      lastSyncedAt: null,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { sourceId, uploadUrl };
  },
});

/** File upload, step 2: text extraction + chunking from the stored blob. */
export const fileReady = mutation({
  args: { workspaceId: v.string(), sourceId: v.id("dataSources"), storageId: v.id("_storage") },
  returns: v.object({ chunkCount: v.number() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: source is not in this workspace.");
    }
    if (source.kind !== "file") throw new Error("INVALID_ARGUMENT: source is not a file.");
    const fileUrl = await ctx.storage.getUrl(args.storageId);
    if (!fileUrl) throw new Error("INVALID_ARGUMENT: the uploaded file could not be read.");
    const buffer = await (await fetch(fileUrl)).arrayBuffer();
    const { extractPrintableText } = await import("./dataSourceText");
    const text = extractPrintableText(buffer);
    if (text.trim().length < 10) {
      await ctx.db.patch(args.sourceId, {
        status: "failed",
        syncError: "No selectable text found. For PDFs, make sure the text is selectable, not a scan.",
        fileId: args.storageId,
        updatedAt: Date.now(),
      });
      throw new Error("INVALID_ARGUMENT: no selectable text found in the file.");
    }
    await clearChunks(ctx, args.sourceId);
    const chunkCount = await insertChunks(ctx, args.workspaceId, args.sourceId, text);
    const now = Date.now();
    await ctx.db.patch(args.sourceId, {
      fileId: args.storageId,
      text: text.slice(0, SNIPPET_MAX),
      status: "ready",
      lastSyncedAt: now,
      syncError: null,
      updatedAt: now,
    });
    return { chunkCount };
  },
});

/** A website ingest, step 1: register + start the Firecrawl job. */
export const addWebsite = mutation({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    url: v.string(),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single")),
    includePaths: v.optional(v.array(v.string())),
    excludePaths: v.optional(v.array(v.string())),
    pageLimit: v.optional(v.number()),
  },
  returns: v.object({ sourceId: v.id("dataSources"), started: v.boolean() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const title = boundedText(args.title, SOURCE_TITLE_MAX) || "Untitled site";
    const raw = args.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    } catch {
      throw new Error("INVALID_ARGUMENT: enter a valid website URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("INVALID_ARGUMENT: only http(s) websites are supported.");
    }
    const now = Date.now();
    const sourceId = await ctx.db.insert("dataSources", {
      workspaceId: args.workspaceId,
      kind: "website",
      title,
      url: parsed.toString(),
      crawlMode: args.crawlMode,
      crawlId: null,
      fileId: null,
      text: null,
      status: "syncing",
      pageCount: 0,
      lastSyncedAt: null,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
    // The Firecrawl job itself runs in an action: "single" scrapes the landing
    // page synchronously; crawl/sitemap start a durable component crawl whose
    // completion callback ingests the stored pages.
    if (args.crawlMode === "single") {
      await ctx.scheduler.runAfter(0, internal.dataFlows.syncSinglePage, {
        sourceId,
        workspaceId: args.workspaceId,
        url: parsed.toString(),
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.dataFlows.startWebsiteCrawl, {
        sourceId,
        workspaceId: args.workspaceId,
        url: parsed.toString(),
        crawlMode: args.crawlMode,
        includePaths: args.includePaths,
        excludePaths: args.excludePaths,
        pageLimit: args.pageLimit,
      });
    }
    return { sourceId, started: true };
  },
});

/** Called by the ingest action once the durable crawl has a Firecrawl id. */
/** Sync input for the resync action: the fields needed to re-run ingest. */
export const getForSync = internalQuery({
  args: { sourceId: v.id("dataSources") },
  returns: v.union(v.null(), v.object({
    workspaceId: v.string(),
    url: v.union(v.string(), v.null()),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single")),
    status: v.string(),
  })),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return null;
    return { workspaceId: source.workspaceId, url: source.url, crawlMode: source.crawlMode, status: source.status };
  },
});

/** Called by the ingest action once the durable crawl has a Firecrawl id. */
export const attachCrawl = internalMutation({
  args: { sourceId: v.id("dataSources"), crawlId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return null;
    await ctx.db.patch(args.sourceId, { crawlId: args.crawlId, updatedAt: Date.now() });
    return null;
  },
});

/** Website sources due for a re-sync, for the auto-resync sweep. */
export const staleWebsites = internalQuery({
  args: { olderThanMs: v.number() },
  returns: v.array(v.object({
    sourceId: v.id("dataSources"),
    workspaceId: v.string(),
    url: v.string(),
    crawlMode: v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single")),
  })),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    // No global kind index exists (kind indexes are workspace-prefixed), and
    // the source list is bounded in practice (<100 per workspace), so a
    // bounded scan with a filter is the honest shape for a once-a-day sweep.
    const all = await ctx.db.query("dataSources").take(1000);
    return all
      .filter(
        (row) =>
          row.kind === "website" &&
          row.status === "ready" &&
          row.url !== null &&
          (row.lastSyncedAt ?? 0) < cutoff,
      )
      .slice(0, 10)
      .map((row) => ({
        sourceId: row._id,
        workspaceId: row.workspaceId,
        url: row.url as string,
        crawlMode: row.crawlMode,
      }));
  },
});

/** Called by the ingest action when the provider refused the job. */
export const markSyncFailed = internalMutation({
  args: { sourceId: v.id("dataSources"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return null;
    await ctx.db.patch(args.sourceId, {
      status: "failed",
      syncError: boundedText(args.error, 240),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Called by the ingest action / crawl callback with the fetched pages. */
export const ingestWebsitePages = internalMutation({
  args: {
    workspaceId: v.string(),
    sourceId: v.id("dataSources"),
    crawlId: v.union(v.string(), v.null()),
    pages: v.array(v.object({ url: v.string(), title: v.string(), content: v.string() })),
    failed: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.object({ chunkCount: v.number(), pageCount: v.number() }),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.workspaceId !== args.workspaceId) return { chunkCount: 0, pageCount: 0 };
    const now = Date.now();
    if (args.failed || args.pages.length === 0) {
      const hasExisting = (await ctx.db.query("dataSourceChunks").withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId)).take(1)).length > 0;
      await ctx.db.patch(args.sourceId, {
        status: hasExisting ? "ready" : "failed",
        syncError: args.error ? boundedText(args.error, 240) : "The website returned no readable content.",
        crawlId: args.crawlId ?? source.crawlId,
        lastSyncedAt: hasExisting ? now : source.lastSyncedAt,
        pageCount: args.pages.length > 0 ? args.pages.length : source.pageCount,
        updatedAt: now,
      });
      return { chunkCount: 0, pageCount: source.pageCount };
    }
    await clearChunks(ctx, args.sourceId);
    const combined = args.pages
      .map((page) => `# ${page.title || page.url}\n\n${page.content}`)
      .join("\n\n");
    const chunkCount = await insertChunks(ctx, args.workspaceId, args.sourceId, combined);
    await ctx.db.patch(args.sourceId, {
      status: "ready",
      crawlId: args.crawlId ?? source.crawlId,
      pageCount: args.pages.length,
      lastSyncedAt: now,
      syncError: null,
      updatedAt: now,
    });
    return { chunkCount, pageCount: args.pages.length };
  },
});

/** Archive keeps the row but excludes it from the agent. */
export const setStatus = mutation({
  args: { workspaceId: v.string(), sourceId: v.id("dataSources"), status: v.union(v.literal("ready"), v.literal("archived")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: source is not in this workspace.");
    }
    await ctx.db.patch(args.sourceId, { status: args.status, updatedAt: Date.now() });
    return null;
  },
});

export const deleteSource = mutation({
  args: { workspaceId: v.string(), sourceId: v.id("dataSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: source is not in this workspace.");
    }
    await clearChunks(ctx, args.sourceId);
    if (source.fileId) {
      try { await ctx.storage.delete(source.fileId); } catch { /* already gone */ }
    }
    await ctx.db.delete(args.sourceId);
    return null;
  },
});

/** Public processing count, used by the frontend progress display. */
export const progress = query({
  args: { workspaceId: v.string() },
  returns: v.object({ activeCount: v.number() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("dataSources")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    return { activeCount: rows.filter((row) => row.status === "syncing").length };
  },
});

/** Count of active sources — surfaced to the agent as part of its context. */
export const activeCount = internalMutation({
  args: { workspaceId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("dataSources")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    return rows.filter((row) => row.status === "ready").length;
  },
});

export const clearChunksForTest = internalMutation({
  args: { sourceId: v.id("dataSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await clearChunks(ctx, args.sourceId);
    return null;
  },
});
