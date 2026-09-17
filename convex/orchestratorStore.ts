import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Transactional bookkeeping for the mission orchestrator. Kept in a
 * non-Node module because Convex allows only actions in "use node" files;
 * these helpers must be mutations/queries so each stage transition commits
 * atomically.
 */

/** Runs that may legally advance: active (working) or queued (not started). */
function advanceable(status: string, stage: string): boolean {
  return status === "active" || (status === "queued" && stage === "intake");
}

type Stage = "intake" | "interpret" | "plan" | "discover" | "evaluate" | "approval" | "execute" | "wait" | "complete";

export const runRow = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.union(v.object({
    _id: v.id("agentRuns"), status: v.string(), currentStage: v.string(), retryCount: v.number(),
  }), v.null()),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    return run ? { _id: run._id, status: run.status, currentStage: run.currentStage, retryCount: run.retryCount } : null;
  },
});

export const stageDone = internalMutation({
  args: { missionId: v.id("missions"), stage: v.string(), nextStage: v.string(), eventType: v.string(), summary: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run || !advanceable(run.status, run.currentStage)) return null;
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: args.nextStage as Stage, targetStatus: "active",
      interruption: null, eventType: args.eventType, safeSummary: args.summary,
    });
    // A completed stage restores the retry budget for later stages.
    if (run.retryCount > 0) await ctx.db.patch(run._id, { retryCount: 0, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return null;
  },
});

export const pendingQueries = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({ _id: v.id("missionQueries"), query: v.string(), kind: v.union(v.literal("search"), v.literal("crawl")) })),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("missionQueries")
      .withIndex("by_missionId_and_status", (q) => q.eq("missionId", args.missionId).eq("status", "pending"))
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt).map(({ _id, query, kind }) => ({ _id, query, kind }));
  },
});

/** Persists the incremented retry counter so auto-retries stay bounded. */
export const bumpRetry = internalMutation({
  args: { missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) return null;
    await ctx.db.patch(run._id, { retryCount: run.retryCount + 1, updatedAt: Date.now() });
    return null;
  },
});

export const completeQuery = internalMutation({
  args: { queryId: v.id("missionQueries"), missionId: v.id("missions"), resultCount: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queryId, { status: "done", resultCount: args.resultCount });
    await ctx.runMutation(internal.runs.recordStepForAction, {
      missionId: args.missionId, stage: "discover", label: "discover.query.done",
      summary: `Discovery query returned ${args.resultCount} deduplicated source${args.resultCount === 1 ? "" : "s"}.`,
      reference: null, errorCode: null, tool: "firecrawl.search",
    });
    return null;
  },
});

export const skipQuery = internalMutation({
  args: { queryId: v.id("missionQueries"), missionId: v.id("missions"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queryId, { status: "skipped" });
    await ctx.runMutation(internal.runs.recordStepForAction, {
      missionId: args.missionId, stage: "discover", label: "discover.query.skipped",
      summary: args.reason, reference: null, errorCode: null, tool: "orchestrator",
    });
    return null;
  },
});

/**
 * Re-opens a stage that a retryable failure parked as `blocked`.
 *
 * `failStage` blocks the run so the failure is visible, then schedules a
 * backoff retry. That retry has to pass back through this mutation first:
 * `blocked` is deliberately not advanceable, so a retry that called `runStage`
 * directly returned immediately and the automatic recovery never actually ran.
 *
 * Guarded so it can never steal a run the user owns: it only acts while the run
 * is still `blocked` on the *same* interruption that scheduled it. If the user
 * stopped the run, raised a budget, or another failure parked it differently in
 * the meantime, this is a no-op.
 */
export const retryResume = internalMutation({
  args: { missionId: v.id("missions"), interruption: v.union(v.string(), v.null()) },
  returns: v.object({ resumed: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run || run.status !== "blocked") return { resumed: false };
    if ((run.activeInterruption ?? null) !== args.interruption) return { resumed: false };
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: run.currentStage as Stage, targetStatus: "active",
      interruption: null, eventType: `stage.${run.currentStage}.retrying`,
      safeSummary: "Retrying this stage automatically after a transient provider failure.",
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return { resumed: true };
  },
});

/**
 * Consumes a discovery query whose provider call failed, with the classified
 * reason. Discovery is best-effort per query: a host Firecrawl refuses (or a
 * transient provider error) skips that query and the run continues down the
 * backlog, instead of throwing out of the stage and stranding the run.
 */
export const failQuery = internalMutation({
  args: { queryId: v.id("missionQueries"), missionId: v.id("missions"), reason: v.string(), errorCode: v.union(v.string(), v.null()), tool: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queryId, { status: "skipped" });
    await ctx.runMutation(internal.runs.recordStepForAction, {
      missionId: args.missionId, stage: "discover", label: "discover.query.failed",
      summary: args.reason, reference: null, errorCode: args.errorCode, tool: args.tool,
    });
    return null;
  },
});

/**
 * Marks the crawl query consumed and parks the run in `wait`. The crawl's own
 * completion callback (researchStore.crawlCompleted) later transitions
 * wait→evaluate; the evaluate stage re-checks the backlog and either resumes
 * discovery or proceeds to explanation.
 */
export const awaitCrawl = internalMutation({
  args: { queryId: v.id("missionQueries"), missionId: v.id("missions"), host: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.queryId, { status: "done", resultCount: null });
    await ctx.runMutation(internal.runs.recordStepForAction, {
      missionId: args.missionId, stage: "discover", label: "discover.crawl.started",
      summary: `Durable crawl of ${args.host} started; Radar continues automatically when it completes.`,
      reference: null, errorCode: null, tool: "firecrawl.crawl",
    });
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (run && advanceable(run.status, run.currentStage)) {
      await ctx.runMutation(internal.runs.transition, {
        missionId: args.missionId, targetStage: "wait", targetStatus: "waiting",
        interruption: null, eventType: "crawl.awaiting",
        safeSummary: `Deep crawl of ${args.host} is running; Radar will continue automatically when it completes.`,
      });
    }
    return null;
  },
});

/**
 * Evaluated after every send: flips the mission complete when the plan's
 * completion predicate is satisfied (a sourced match exists AND an approved
 * action was sent). Late approvals still close the loop.
 */
export const checkCompletion = internalMutation({
  args: { missionId: v.id("missions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || ["complete", "cancelled"].includes(mission.status)) return false;
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run || run.status === "cancelled") return false;
    const drafts = await ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    const hasSent = drafts.some((draft) => ["sent", "delivered"].includes(draft.status));
    if (!hasSent) return false;
    const matches = await ctx.db.query("matches").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    if (matches.length === 0) return false;
    const now = Date.now();
    await ctx.db.patch(args.missionId, { status: "complete", updatedAt: now });
    if (run.status !== "complete") {
      await ctx.db.patch(run._id, { status: "complete", currentStage: "complete", finishedAt: now, updatedAt: now });
      await ctx.db.insert("runEvents", {
        missionId: args.missionId, runId: run._id, type: "mission.complete", stage: "complete",
        safeSummary: "Completion predicate satisfied: a sourced match was approved and sent.",
        createdAt: now,
      });
    }
    return true;
  },
});

// ---- user-facing controls ----

/**
 * Public entry: run the mission end-to-end from its queued state. The first
 * scheduled stage does the rest; Stop remains available at every point.
 */
export const runPipeline = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.object({ started: v.boolean(), stage: v.string() }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) throw new Error("Run not found for this mission.");
    if (run.status !== "queued") return { started: false, stage: run.currentStage };
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return { started: true, stage: run.currentStage };
  },
});

/** User stop: cancels the run; an in-flight stage finishes, then everything halts. */
export const stopRun = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) throw new Error("Run not found for this mission.");
    if (["cancelled", "complete", "failed"].includes(run.status)) return null;
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: run.currentStage, targetStatus: "cancelled",
      interruption: "user_requested", eventType: "run.stopped",
      safeSummary: "Mission stopped by the user. No further stages will execute.",
    });
    return null;
  },
});

/** Resume a blocked stage after a classified, retryable failure. */
export const retryStage = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) throw new Error("Run not found for this mission.");
    if (run.status !== "blocked") throw new Error("INVALID_STATE: only a blocked run can be retried.");
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: run.currentStage, targetStatus: "active",
      interruption: null, eventType: "stage.retried", safeSummary: "User resumed the blocked stage.",
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return null;
  },
});
