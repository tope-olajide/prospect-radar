import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { chunkText, toSearchText } from "../convex/dataSourceText";

const modules = import.meta.glob("../convex/**/*.*s");

const WORKSPACE = "demo-workspace";

describe("data source text utilities", () => {
  it("chunks long text at word boundaries without exceeding the target size", () => {
    const paragraph = "word ".repeat(600); // 3000 chars, one "paragraph"
    const chunks = chunkText(paragraph);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1350);
      expect(chunk.startsWith(" ")).toBe(false);
    }
  });

  it("keeps a short text as a single chunk", () => {
    const chunks = chunkText("A short portfolio snippet.");
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("A short portfolio snippet.");
  });

  it("builds searchText as normalized lowercase so retrieval is case-insensitive", () => {
    expect(toSearchText("Acme Design Studio\nLogos and brand identity")).toBe("acme design studio logos and brand identity");
  });
});

describe("data sources CRUD and retrieval", () => {
  let t: ReturnType<typeof convexTest<typeof schema>>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("adds a snippet, chunks it, and exposes it in the list", async () => {
    await t.mutation(api.dataSources.addSnippet, {
      workspaceId: WORKSPACE,
      title: "Portfolio",
      text: "I build React dashboards. ".repeat(200),
    });
    const rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("snippet");
    expect(rows[0].title).toBe("Portfolio");
    expect(rows[0].chunkCount).toBeGreaterThan(1);
    expect(rows[0].status).toBe("ready");
  });

  it("registers a file source and returns an upload URL, keeping it syncing until finalization", async () => {
    const { sourceId, uploadUrl } = await t.mutation(api.dataSources.addFile, {
      workspaceId: WORKSPACE,
      title: "resume.txt",
      sizeBytes: 1024,
    });
    expect(uploadUrl).toBeTruthy();
    const rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows[0].kind).toBe("file");
    expect(rows[0].status).toBe("syncing");
    expect(sourceId).toBeDefined();
  });

  it("rejects a file above the 20 MB limit", async () => {
    await expect(
      t.mutation(api.dataSources.addFile, {
        workspaceId: WORKSPACE,
        title: "huge.pdf",
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).rejects.toThrow();
  });

  it("retrieves mission-relevant chunks across sources, most relevant first", async () => {
    await t.mutation(api.dataSources.addSnippet, {
      workspaceId: WORKSPACE,
      title: "Portfolio",
      text: "I build React and TypeScript dashboards for SaaS startups.",
    });
    await t.mutation(api.dataSources.addSnippet, {
      workspaceId: WORKSPACE,
      title: "Catering menu",
      text: "Wedding catering packages with seasonal menus and dessert tables.",
    });
    const chunks = await t.query(internal.dataSources.relevantChunks, {
      workspaceId: WORKSPACE,
      query: "React TypeScript dashboard developer",
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].title).toBe("Portfolio");
    expect(chunks[0].text).toContain("React");
  });

  it("returns no chunks for an unrelated query or an empty workspace", async () => {
    await t.mutation(api.dataSources.addSnippet, {
      workspaceId: WORKSPACE,
      title: "Portfolio",
      text: "React developer portfolio.",
    });
    const miss = await t.query(internal.dataSources.relevantChunks, {
      workspaceId: WORKSPACE,
      query: "underwater basket weaving certification",
    });
    expect(miss).toHaveLength(0);
    const empty = await t.query(internal.dataSources.relevantChunks, {
      workspaceId: "other-workspace",
      query: "React developer",
    });
    expect(empty).toHaveLength(0);
  });

  it("rejects oversized snippets instead of silently truncating", async () => {
    await expect(
      t.mutation(api.dataSources.addSnippet, {
        workspaceId: WORKSPACE,
        title: "Too big",
        text: "x".repeat(25_000),
      }),
    ).rejects.toThrow();
  });

  it("removes a source and its chunks together", async () => {
    const sourceId = await t.mutation(api.dataSources.addSnippet, {
      workspaceId: WORKSPACE,
      title: "Temp",
      text: "Temporary source.",
    });
    await t.mutation(api.dataSources.deleteSource, { workspaceId: WORKSPACE, sourceId });
    const rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows).toHaveLength(0);
  });
});

describe("website ingest flow", () => {
  let t: ReturnType<typeof convexTest<typeof schema>>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("registers a website and reports syncing until the sync lands chunks", async () => {
    const { sourceId } = await t.mutation(api.dataSources.addWebsite, {
      workspaceId: WORKSPACE,
      title: "Acme site",
      url: "https://example.com/portfolio",
      crawlMode: "single",
    });
    let rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows[0].kind).toBe("website");
    expect(rows[0].status).toBe("syncing");

    // Simulate the Firecrawl callback storing pages.
    await t.mutation(internal.dataSources.ingestWebsitePages, {
      sourceId,
      workspaceId: WORKSPACE,
      crawlId: "crawl_test_1",
      pages: [{ url: "https://example.com/portfolio", title: "Portfolio", content: "# Work\nReact dashboards for SaaS." }],
      failed: false,
    });

    rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows[0].status).toBe("ready");
    expect(rows[0].chunkCount).toBeGreaterThan(0);
    expect(rows[0].lastSyncedAt).not.toBeNull();
  });

  it("marks a failed sync as failed without losing the source", async () => {
    await t.mutation(api.dataSources.addWebsite, {
      workspaceId: WORKSPACE,
      title: "Blocked site",
      url: "https://blocked.example.com",
      crawlMode: "crawl",
    });
    const rowsBefore = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    await t.mutation(internal.dataSources.markSyncFailed, {
      sourceId: rowsBefore[0]._id,
      error: "FIRECRAWL_ROBOTS_REFUSED: blocked by robots.txt",
    });
    const rows = await t.query(api.dataSources.list, { workspaceId: WORKSPACE });
    expect(rows[0].status).toBe("failed");
    expect(rows[0].syncError).toContain("ROBOTS");
    expect(rows[0].title).toBe("Blocked site");
  });

  it("ignores a page callback whose source is already gone", async () => {
    const { sourceId } = await t.mutation(api.dataSources.addWebsite, {
      workspaceId: WORKSPACE,
      title: "Gone",
      url: "https://example.com/x",
      crawlMode: "single",
    });
    await t.mutation(api.dataSources.deleteSource, { workspaceId: WORKSPACE, sourceId });
    await expect(
      t.mutation(internal.dataSources.ingestWebsitePages, {
        sourceId,
        workspaceId: WORKSPACE,
        crawlId: "crawl_late",
        pages: [],
        failed: false,
      }),
    ).resolves.toEqual({ chunkCount: 0, pageCount: 0 });
  });
});
