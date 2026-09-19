import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { validateWorkspace } from "./model/auth";

/**
 * Provider-credit budget (docs/execution-plan.md Phase 6).
 *
 * "Run Radar end-to-end" spends real Firecrawl credits, so the cost of a
 * mission is estimated *before* it starts and enforced as a hard cap while it
 * runs. Running out of credits is a *budget block*, not an error: the run parks
 * in `blocked` with `activeInterruption: "budget_blocked"`, keeps its place, and
 * resumes from the same stage once credits are available.
 *
 * Two tables:
 *  - `workspaceBudgets` — one row per workspace: the hard cap.
 *  - `creditCharges`    — the append-only ledger of what each provider call
 *                         actually cost. Idempotent by provider reference, so a
 *                         retried call never double-charges.
 */

/**
 * Firecrawl bills per page/result. These are the estimates the guard uses and
 * the amounts the ledger records; they are deliberately conservative (an
 * over-estimate blocks early, which is recoverable, an under-estimate does not).
 */
export const CREDIT_COST = {
  /** One credit per requested search result. */
  searchPerResult: 1,
  /** One credit per crawled page. */
  crawlPerPage: 1,
  /** One credit per scraped page. */
  scrape: 1,
  /** One credit per structured (JSON-mode) extraction. */
  extract: 1,
} as const;

/** Default hard cap when a workspace has never set one. */
export const DEFAULT_CREDIT_LIMIT = 400;
/** Bounds on a user-set cap. */
export const MIN_CREDIT_LIMIT = 10;
export const MAX_CREDIT_LIMIT = 100_000;

/** Search page size the orchestrator requests (must match missionOrchestrator). */
export const ORCHESTRATOR_SEARCH_LIMIT = 4;
/** Crawl page budget the orchestrator requests. */
export const ORCHESTRATOR_CRAWL_LIMIT = 10;
/** Sources the evaluate stage resolves into entities. */
export const ORCHESTRATOR_EXTRACT_LIMIT = 4;

export type ChargeKind = "search" | "crawl" | "scrape" | "extract";

export function estimateSearch(limit: number): number {
  return Math.max(1, Math.floor(limit)) * CREDIT_COST.searchPerResult;
}

export function estimateCrawl(limit: number): number {
  return Math.max(1, Math.floor(limit)) * CREDIT_COST.crawlPerPage;
}

export function estimateExtraction(count: number): number {
  return Math.max(1, Math.floor(count)) * CREDIT_COST.extract;
}

/**
 * Estimated cost of the work still pending for a mission: one search per pending
 * search query, one crawl for the crawl backlog, plus one extraction credit per
 * source the evaluate stage will resolve (the count itself is already the
 * batch size, so it is not multiplied by the batch limit again).
 */
export function estimateMission(input: { pendingSearches: number; pendingCrawls: number; resolvableSources: number }): number {
  return (
    input.pendingSearches * estimateSearch(ORCHESTRATOR_SEARCH_LIMIT) +
    input.pendingCrawls * estimateCrawl(ORCHESTRATOR_CRAWL_LIMIT) +
    input.resolvableSources * CREDIT_COST.extract
  );
}

const CHARGE_KINDS = ["search", "crawl", "scrape", "extract"] as const;

// Read-only helpers: typed against the query context so both queries and
// mutations can share them (a mutation context is a superset).
async function limitFor(ctx: QueryCtx, workspaceId: string): Promise<number> {
  const row = await ctx.db.query("workspaceBudgets").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).first();
  return row?.creditLimit ?? DEFAULT_CREDIT_LIMIT;
}

/** Total credits already charged in a workspace. */
async function usedFor(ctx: QueryCtx, workspaceId: string): Promise<number> {
  const rows = await ctx.db.query("creditCharges").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(2000);
  return rows.reduce((total, row) => total + row.amount, 0);
}

/** Splits already-charged credits by provider operation. */
async function breakdownFor(ctx: QueryCtx, workspaceId: string) {
  const rows = await ctx.db.query("creditCharges").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(2000);
  const breakdown: Record<ChargeKind, number> = { search: 0, crawl: 0, scrape: 0, extract: 0 };
  for (const row of rows) breakdown[row.kind] += row.amount;
  return breakdown;
}

/**
 * Records what a provider call actually cost. Idempotent by
 * `(workspaceId, reference)`: replaying the same call — a retried action, a
 * re-delivered webhook — never charges twice.
 *
 * Deliberately advisory: accounting must never fail the operation it describes.
 */
export const charge = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    kind: v.union(v.literal("search"), v.literal("crawl"), v.literal("scrape"), v.literal("extract")),
    amount: v.number(),
    reference: v.string(),
  },
  returns: v.object({ charged: v.boolean(), amount: v.number() }),
  handler: async (ctx, args) => {
    const amount = Math.max(1, Math.floor(args.amount));
    const existing = await ctx.db
      .query("creditCharges")
      .withIndex("by_workspaceId_and_reference", (q) => q.eq("workspaceId", args.workspaceId).eq("reference", args.reference))
      .first();
    if (existing) return { charged: false, amount: existing.amount };
    await ctx.db.insert("creditCharges", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      kind: args.kind,
      amount,
      reference: args.reference,
      createdAt: Date.now(),
    });
    return { charged: true, amount };
  },
});

/**
 * The pre-flight gate. Called before any provider call the orchestrator is
 * about to make; returns whether the estimate fits inside the remaining budget.
 */
/**
 * Whether an estimated call fits inside the remaining budget.
 *
 * Extracted so read-only surfaces — the capability query the UI reads — can ask
 * the same question the orchestrator asks before spending, without duplicating
 * the arithmetic and drifting from it.
 */
export async function allowedFor(ctx: QueryCtx, workspaceId: string, estimate: number): Promise<boolean> {
  const creditLimit = await limitFor(ctx, workspaceId);
  const used = await usedFor(ctx, workspaceId);
  return Math.max(0, creditLimit - used) >= Math.max(0, Math.floor(estimate));
}

export const check = internalQuery({
  args: { workspaceId: v.string(), estimate: v.number() },
  returns: v.object({ allowed: v.boolean(), creditLimit: v.number(), used: v.number(), remaining: v.number(), estimate: v.number() }),
  handler: async (ctx, args) => {
    const creditLimit = await limitFor(ctx, args.workspaceId);
    const used = await usedFor(ctx, args.workspaceId);
    const remaining = Math.max(0, creditLimit - used);
    const estimate = Math.max(0, Math.floor(args.estimate));
    return { allowed: remaining >= estimate, creditLimit, used, remaining, estimate };
  },
});

/**
 * User-facing budget state for the mission console: the cap, what has been
 * spent, what is left, and what the pending work is estimated to cost.
 */
export const status = query({
  args: { workspaceId: v.string(), missionId: v.union(v.id("missions"), v.null()) },
  returns: v.object({
    creditLimit: v.number(),
    used: v.number(),
    remaining: v.number(),
    breakdown: v.object({ search: v.number(), crawl: v.number(), scrape: v.number(), extract: v.number() }),
    pendingEstimate: v.number(),
    allowed: v.boolean(),
    exhausted: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const creditLimit = await limitFor(ctx, args.workspaceId);
    const used = await usedFor(ctx, args.workspaceId);
    const remaining = Math.max(0, creditLimit - used);
    const breakdown = await breakdownFor(ctx, args.workspaceId);

    let pendingSearches = 0;
    let pendingCrawls = 0;
    let resolvableSources = 0;
    if (args.missionId) {
      const pending = await ctx.db
        .query("missionQueries")
        .withIndex("by_missionId_and_status", (q) => q.eq("missionId", args.missionId as Id<"missions">).eq("status", "pending"))
        .take(200);
      pendingSearches = pending.filter((row) => row.kind === "search").length;
      pendingCrawls = pending.filter((row) => row.kind === "crawl").length;
      // Sources that discovery found but that nothing has resolved into an
      // entity yet: these are what the evaluate stage will spend extraction
      // credits on.
      const sources = await ctx.db.query("sourceRecords").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId as Id<"missions">)).take(200);
      const unresolved = sources.filter((source) => source.processingStatus === "discovered").length;
      resolvableSources = Math.min(ORCHESTRATOR_EXTRACT_LIMIT, unresolved);
    }

    const pendingEstimate = estimateMission({ pendingSearches, pendingCrawls, resolvableSources });
    return {
      creditLimit,
      used,
      remaining,
      breakdown,
      pendingEstimate,
      allowed: remaining >= pendingEstimate,
      exhausted: remaining <= 0,
    };
  },
});

/** Sets the workspace hard cap, bounded so a typo cannot disable the guard. */
export const setLimit = mutation({
  args: { workspaceId: v.string(), creditLimit: v.number() },
  returns: v.object({ creditLimit: v.number() }),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const requested = Math.floor(args.creditLimit);
    if (!Number.isFinite(requested) || requested < MIN_CREDIT_LIMIT || requested > MAX_CREDIT_LIMIT) {
      throw new Error(`INVALID_ARGUMENT: the credit cap must be between ${MIN_CREDIT_LIMIT} and ${MAX_CREDIT_LIMIT}.`);
    }
    const now = Date.now();
    const existing = await ctx.db.query("workspaceBudgets").withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId)).first();
    if (existing) {
      await ctx.db.patch(existing._id, { creditLimit: requested, updatedAt: now });
    } else {
      await ctx.db.insert("workspaceBudgets", { workspaceId: args.workspaceId, creditLimit: requested, updatedAt: now });
    }
    return { creditLimit: requested };
  },
});

/** Test/debug helper: the raw ledger for a mission. */
export const chargesForMission = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(v.object({ kind: v.string(), amount: v.number(), reference: v.string(), createdAt: v.number() })),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db.query("creditCharges").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).take(200);
    return rows
      .filter((row) => row.workspaceId === args.workspaceId)
      .map((row) => ({ kind: row.kind, amount: row.amount, reference: row.reference, createdAt: row.createdAt }));
  },
});

export { CHARGE_KINDS };
