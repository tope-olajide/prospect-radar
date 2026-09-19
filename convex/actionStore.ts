/**
 * Persistence for the action-decision layer.
 *
 * A decision is written every time the agent evaluates what to do, keyed by
 * (mission, match) so re-deciding updates the row rather than appending a
 * contradictory history. What matters is that the *current* reason is readable
 * later: a user asking "why didn't Radar contact these?" is asking for the same
 * answer the agent used, not a reconstruction.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const decisionValue = v.union(
  v.literal("send_email"),
  v.literal("submit_form"),
  v.literal("investigate"),
  v.literal("no_action"),
);

const actionabilityValue = v.union(
  v.literal("ready"),
  v.literal("investigate"),
  v.literal("blocked"),
  v.literal("result_only"),
  v.literal("not_actionable"),
);

export const saveDecision = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    matchId: v.id("matches"),
    quality: v.string(),
    decision: decisionValue,
    actionability: actionabilityValue,
    reason: v.string(),
    detail: v.string(),
    targetUrl: v.union(v.string(), v.null()),
    // ── The trace ──
    evidence: v.optional(v.array(v.string())),
    capability: v.optional(v.union(v.string(), v.null())),
    usedFacts: v.optional(v.array(v.object({ category: v.string(), value: v.string() }))),
    artifacts: v.optional(v.array(v.object({ sourceId: v.id("dataSources"), title: v.string() }))),
    alternatives: v.optional(v.array(v.object({ decision: v.string(), reason: v.string() }))),
    nextStage: v.optional(v.string()),
    missingEvidence: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.id("actionDecisions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("actionDecisions")
      .withIndex("by_missionId_and_matchId", (q) => q.eq("missionId", args.missionId).eq("matchId", args.matchId))
      .first();
    const fields = {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      matchId: args.matchId,
      quality: args.quality,
      decision: args.decision,
      actionability: args.actionability,
      reason: args.reason,
      detail: args.detail,
      targetUrl: args.targetUrl,
      evidence: args.evidence,
      capability: args.capability ?? undefined,
      usedFacts: args.usedFacts,
      artifacts: args.artifacts,
      alternatives: args.alternatives,
      nextStage: args.nextStage,
      missingEvidence: args.missingEvidence ?? undefined,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("actionDecisions", { ...fields, createdAt: now });
  },
});

export const decisionsForMission = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({
    _id: v.id("actionDecisions"),
    matchId: v.id("matches"),
    quality: v.string(),
    decision: decisionValue,
    actionability: actionabilityValue,
    reason: v.string(),
    detail: v.string(),
    evidence: v.array(v.string()),
    capability: v.union(v.string(), v.null()),
    usedFacts: v.array(v.object({ category: v.string(), value: v.string() })),
    artifacts: v.array(v.object({ sourceId: v.id("dataSources"), title: v.string() })),
    alternatives: v.array(v.object({ decision: v.string(), reason: v.string() })),
    nextStage: v.union(v.string(), v.null()),
    missingEvidence: v.union(v.string(), v.null()),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("actionDecisions")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();
    return rows.map((row) => ({
      _id: row._id,
      matchId: row.matchId,
      quality: row.quality,
      decision: row.decision,
      actionability: row.actionability,
      reason: row.reason,
      detail: row.detail,
      evidence: row.evidence ?? [],
      capability: row.capability ?? null,
      usedFacts: row.usedFacts ?? [],
      artifacts: row.artifacts ?? [],
      alternatives: row.alternatives ?? [],
      nextStage: row.nextStage ?? null,
      missingEvidence: row.missingEvidence ?? null,
      createdAt: row.createdAt,
    }));
  },
});

/**
 * The authorized context an action may represent the user with.
 *
 * This is the same set the draft and form paths draw on — user-confirmed or
 * user-corrected facts, workspace-wide or scoped to this mission — recorded on
 * the decision so the trace states which context the action had available,
 * rather than leaving it to be inferred later.
 */
export const authorizedContextFor = internalQuery({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(v.object({ category: v.string(), value: v.string() })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    return rows
      .filter((row) =>
        ["user_confirmed", "user_corrected"].includes(row.verificationStatus) &&
        (row.missionId === null || row.missionId === args.missionId))
      .slice(0, 20)
      .map((row) => ({ category: row.category, value: row.value }));
  },
});

/**
 * How many times this mission has already sent itself back to research.
 *
 * Counted from the run steps rather than a counter field so it is inspectable
 * in the same transcript the user reads, and so a replayed step cannot inflate
 * the budget differently from what was displayed.
 */
export const investigationCount = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("agentRuns")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .first();
    if (!run) return 0;
    const steps = await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run._id)).collect();
    return steps.filter((step) => step.label === "action.investigate").length;
  },
});

/**
 * Everything the decision layer needs about a mission's candidates, in one
 * read: the evaluated matches, the contact route resolved for each, whether a
 * form was already scouted for that source, and whether anything has been
 * prepared for the counterpart already.
 */
export const candidateInputs = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({
    matchId: v.id("matches"),
    sourceId: v.id("sourceRecords"),
    subject: v.string(),
    label: v.string(),
    routeKind: v.union(v.literal("email"), v.literal("form"), v.literal("linkedin"), v.null()),
    routeValue: v.union(v.string(), v.null()),
    routeVerified: v.boolean(),
    formBlocked: v.boolean(),
    alreadyActioned: v.boolean(),
    investigateUrl: v.union(v.string(), v.null()),
    evidenceCount: v.number(),
    evidence: v.array(v.string()),
  })),
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();
    const drafts = await ctx.db
      .query("actionDrafts")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();
    const scouted = await ctx.db
      .query("formTemplates")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .collect();

    const out = [];
    for (const match of matches) {
      const [discovery, source] = await Promise.all([ctx.db.get(match.discoveryId), ctx.db.get(match.sourceId)]);
      if (!discovery || !source) continue;
      const entity = await ctx.db
        .query("entities")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", source._id))
        .first();
      const route = entity?.contactRoute ?? null;
      const routeKind = (route?.kind ?? null) as "email" | "form" | "linkedin" | null;
      const routeValue = route?.value ?? null;
      const routeVerified =
        routeKind === "email" && routeValue !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(routeValue)
          ? true
          : routeKind === "form" && routeValue !== null && /^https?:\/\//.test(routeValue);

      // A form route is usable unless a form was actually read and found
      // unsubmittable. An unread form is not a blocker: reading it is part of
      // preparing the submission.
      const template = scouted.find((row) => row.sourceId === source._id);
      const formBlocked = Boolean(template && (template.blockedReason !== null || template.fields.length === 0));

      out.push({
        matchId: match._id,
        sourceId: source._id,
        subject: discovery.subject,
        label: match.label,
        routeKind,
        routeValue,
        routeVerified,
        formBlocked,
        alreadyActioned: drafts.some((draft) => draft.matchId === match._id),
        // Where to look when evidence is thin or no route has been found: the
        // counterpart's own site first, then the page Radar matched.
        investigateUrl: entity?.canonicalUrl || source.url || null,
        evidenceCount: match.positiveEvidence.length,
        // The cited evidence itself, so the persisted decision can show what it
        // rested on rather than only how much there was.
        evidence: match.positiveEvidence.slice(0, 5),
      });
    }
    return out;
  },
});
