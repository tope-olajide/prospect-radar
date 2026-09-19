/**
 * The capability surface the UI reads.
 *
 * `actionDecision.CAPABILITIES` declares what Radar can do and what each
 * capability needs at runtime; this resolves that declaration against live
 * workspace state. The decision layer and the UI read the same registry, so the
 * app cannot offer a button for an action Radar would refuse to take — and
 * Radar cannot propose one the app could not carry out either.
 *
 * Everything here is a read: nothing about asking this question changes state.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { resolveCapabilities, type CapabilityRuntime } from "./actionDecision";
import { allowedFor } from "./budget";
import { ORCHESTRATOR_SEARCH_LIMIT } from "./budget";
import { validateWorkspace } from "./model/auth";

const state = v.object({
  key: v.string(),
  label: v.string(),
  implemented: v.boolean(),
  available: v.boolean(),
  unavailableReason: v.union(v.string(), v.null()),
});

/**
 * Whether the deployment has a research provider at all.
 *
 * A runtime that cannot read deployment env reports `undefined`; that is not
 * evidence of a missing provider, so it is treated as configured rather than
 * hiding capabilities that work. An empty value is the readable signal that
 * nothing is set up.
 */
function researchConfigured(): boolean {
  const key = process.env.FIRECRAWL_API_KEY;
  return typeof key === "string" ? key.trim().length > 0 : true;
}

export const list = query({
  args: { workspaceId: v.string(), missionId: v.optional(v.id("missions")) },
  returns: v.array(state),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);

    // Email needs somewhere to send from, and that is a workspace fact.
    const inbox = await ctx.db
      .query("agentInboxes")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();

    // A form needs a page to read. Scoped to the mission when one is given;
    // otherwise any website the user has added, which is what the Discover
    // form panel offers to scout.
    let hasScrapableTarget = false;
    if (args.missionId) {
      const mission = await ctx.db.get(args.missionId);
      if (mission && mission.workspaceId === args.workspaceId) {
        const source = await ctx.db
          .query("sourceRecords")
          .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId as Id<"missions">))
          .first();
        hasScrapableTarget = source !== null;
      }
    } else {
      const rows = await ctx.db
        .query("dataSources")
        .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
        .take(60);
      hasScrapableTarget = rows.some((row) => row.kind === "website" && row.status === "ready");
    }

    // The cheapest research call is a search; if even that does not fit, more
    // research is not an option right now.
    const budgetAllowed = await allowedFor(ctx, args.workspaceId, ORCHESTRATOR_SEARCH_LIMIT);

    const runtime: CapabilityRuntime = {
      hasInbox: inbox !== null,
      hasScrapableTarget,
      budgetAllowed,
      researchConfigured: researchConfigured(),
    };
    return resolveCapabilities(runtime);
  },
});
