import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { validateWorkspace } from "./model/auth";

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

type Stage = "intake" | "interpret" | "plan" | "context_check" | "plan_review" | "discover" | "check_in" | "evaluate" | "approval" | "execute" | "observe" | "wait" | "complete";

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
    // A mission is satisfied by any executed action, not only an email. Checking
    // actionDrafts alone made a form-only mission impossible to complete: the
    // form path calls this on success, but no draft ever exists for it.
    const drafts = await ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    const hasSentDraft = drafts.some((draft) => ["sent", "delivered"].includes(draft.status));
    const submissions = await ctx.db.query("formSubmissions").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    const hasSubmittedForm = submissions.some((row) => row.status === "submitted");
    if (!hasSentDraft && !hasSubmittedForm) return false;
    const matches = await ctx.db.query("matches").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    if (matches.length === 0) return false;
    const now = Date.now();
    await ctx.db.patch(args.missionId, { status: "complete", updatedAt: now });
    if (run.status !== "complete") {
      await ctx.db.patch(run._id, { status: "complete", currentStage: "complete", finishedAt: now, updatedAt: now });
      await ctx.db.insert("runEvents", {
        missionId: args.missionId, runId: run._id,        type: "mission.complete", stage: "complete",
        safeSummary: "Completion predicate satisfied: an approved action was executed against a sourced match.",
        createdAt: now,
      });
    }
    return true;
  },
});

/**
 * What actually happened on a mission, as counts.
 *
 * The `observe` stage decides from this and nothing else, so the decision stays
 * inspectable: whoever is reading the run can read the same numbers the agent
 * read, rather than being told a conclusion.
 */
export const observationFor = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.object({
    pendingApproval: v.number(), approvedPending: v.number(),
    sent: v.number(), failed: v.number(), engaged: v.number(),
  }),
  handler: async (ctx, args) => {
    const drafts = await ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    const outcomes = await ctx.db.query("outcomes").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    return {
      pendingApproval: drafts.filter((draft) => draft.status === "awaiting_approval").length,
      approvedPending: drafts.filter((draft) => draft.status === "approved").length,
      sent: drafts.filter((draft) => ["sent", "delivered"].includes(draft.status)).length,
      failed: drafts.filter((draft) => draft.status === "failed").length,
      engaged: outcomes.filter((outcome) => ["replied", "positive"].includes(outcome.status)).length,
    };
  },
});

/**
 * Parks a finished stage in `wait`, scheduling the wake that will read
 * `nextWakeAt`.
 *
 * `nextWakeAt` previously had three writers and no reader, so a mission that
 * reported itself as waiting was waiting for nothing. Parking now schedules its
 * own wake, which gives the field its first real consumer.
 */
export const parkWaiting = internalMutation({
  args: { missionId: v.id("missions"), reason: v.string(), horizonMs: v.number() },
  returns: v.object({ parked: v.boolean(), wakeAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    // Only an active run parks. A run the user stopped, or one another
    // invocation already parked, must not be stolen.
    if (!run || run.status !== "active") return { parked: false, wakeAt: null };
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: "wait" as Stage, targetStatus: "waiting",
      interruption: null, eventType: "mission.waiting", safeSummary: args.reason,
    });
    const wakeAt = args.horizonMs > 0 ? Date.now() + args.horizonMs : null;
    if (wakeAt) {
      await ctx.db.patch(run._id, { nextWakeAt: wakeAt, updatedAt: Date.now() });
      await ctx.scheduler.runAt(wakeAt, internal.orchestratorStore.wakeScheduled, { missionId: args.missionId });
    }
    return { parked: true, wakeAt };
  },
});

/**
 * The reader for `nextWakeAt`: resumes a parked mission whose horizon has passed.
 *
 * The guard is on the exact parked state, so a timeout wake that was scheduled
 * before an event-driven wake arrived is a no-op instead of a second resume.
 */
export const wakeScheduled = internalMutation({
  args: { missionId: v.id("missions") },
  returns: v.object({ woken: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run || run.status !== "waiting" || run.currentStage !== "wait") return { woken: false };
    if (run.nextWakeAt === null || run.nextWakeAt > Date.now()) return { woken: false };
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: "observe" as Stage, targetStatus: "active",
      interruption: null, eventType: "mission.woken",
      safeSummary: "The wait horizon passed — checking for new external activity.",
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return { woken: true };
  },
});

/**
 * Resumes a parked mission because something happened outside it.
 *
 * Only a `waiting` run is woken. A run that is mid-stage already owns its own
 * continuation, and resuming it here would race the stage in flight. Both parked
 * stages are eligible, because a reply usually arrives while the mission is
 * sitting on the approval gate — the most likely place for it to be parked.
 */
export const wakeForEvent = internalMutation({
  args: { missionId: v.id("missions"), reason: v.string() },
  returns: v.object({ woken: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run || run.status !== "waiting") return { woken: false };
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: "observe" as Stage, targetStatus: "active",
      interruption: null, eventType: "mission.woken", safeSummary: args.reason,
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return { woken: true };
  },
});

/**
 * Resumes the mission because the user approved an action.
 *
 * Without this the gate had no exit: approving a draft left the run parked at
 * `approval`, and the approved action was only ever executed if a page called
 * `send` — which is the difference between an agent and a dashboard. Deliberately
 * narrow: it only moves a run that is actually parked on `approval`, so approving
 * an action while a stage is mid-flight cannot yank the run out of its work.
 */
export const advanceToExecute = internalMutation({
  args: { missionId: v.id("missions") },
  returns: v.object({ advanced: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) return { advanced: false };
    if (run.currentStage !== "approval") return { advanced: false };
    if (run.status !== "waiting" && run.status !== "active") return { advanced: false };
    // Only advance when something is genuinely approved and unsent. A gate that
    // was reopened with nothing actionable stays open rather than cycling
    // through execute and back.
    const drafts = await ctx.db.query("actionDrafts").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).collect();
    if (!drafts.some((draft) => draft.status === "approved")) return { advanced: false };
    try {
      await ctx.runMutation(internal.runs.transition, {
        missionId: args.missionId, targetStage: "execute" as Stage, targetStatus: "active",
        interruption: null, eventType: "action.approved.executing",
        safeSummary: "User approved the exact content — the agent is executing it.",
      });
    } catch {
      return { advanced: false };
    }
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return { advanced: true };
  },
});

/**
 * Answer a context_check question — the user provides missing information
 * that Radar needs before it can plan.
 *
 * Each answer becomes a confirmed fact in the workspace context, so Radar
 * can reuse it across future missions without asking again.
 */
export const answerContextCheck = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions"), key: v.string(), answer: v.string() },
  returns: v.object({ factId: v.id("contextFacts"), resumed: v.boolean() }),
  handler: async (ctx, args): Promise<{ factId: Id<"contextFacts">; resumed: boolean }> => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const answer = args.answer.trim().slice(0, 600);
    if (!answer) throw new Error("INVALID_ARGUMENT: an answer is required.");
    const now = Date.now();

    // Persist the answer as a confirmed workspace fact, so it persists across
    // missions. The category mirrors the requirement key so the readiness
    // checker can match it.
    const factId = await ctx.db.insert("contextFacts", {
      workspaceId: args.workspaceId,
      missionId: null, // workspace-wide: reusable across missions
      category: args.key,
      value: answer,
      sourceType: "user_input",
      sourceReference: null,
      confidence: 1,
      verificationStatus: "user_confirmed",
      visibility: "workspace",
      createdAt: now,
      updatedAt: now,
    });

    // Log the answer as a run event.
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (run) {
      await ctx.db.insert("runEvents", {
        missionId: args.missionId,
        runId: run._id,
        type: "context_check.answered",
        stage: "context_check" as Stage,
        safeSummary: `Provided: ${args.key} = ${answer.slice(0, 80)}`,
        createdAt: now,
      });
    }

    // Resume: re-run the readiness check, which will now see the new fact.
    let resumed = false;
    if (run) {
      try {
        await ctx.runMutation(internal.runs.transition, {
          missionId: args.missionId, targetStage: "context_check", targetStatus: "active",
          interruption: null, eventType: "context_check.resumed",
          safeSummary: "Answer recorded — Radar is re-checking its readiness.",
        });
        resumed = true;
      } catch {
        resumed = false;
      }
      if (resumed) {
        await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
      }
    }
    return { factId, resumed };
  },
});

/**
 * The user's answer to a clarification the classifier asked for.
 *
 * This replaces a path that appended the answer to `rawGoal` and had the page
 * call the classifier directly. Three things were wrong with that: the answer
 * never became part of the user's context, nothing recorded that Radar had even
 * asked, and the run was left `active` at `intake` with no scheduled work — so
 * the only thing that ever moved it again was the reaper.
 *
 * Here the answer is a first-class fact: mission-scoped, `user_input`,
 * `user_confirmed`, so it is both visible to the classifier on the re-run and
 * usable later when the agent represents the user. The request and the answer
 * are recorded as run events, and the run is re-scheduled so the mission
 * continues on its own.
 */
export const answerClarification = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions"), answer: v.string() },
  returns: v.object({ factId: v.id("contextFacts"), resumed: v.boolean() }),
  handler: async (ctx, args): Promise<{ factId: Id<"contextFacts">; resumed: boolean }> => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const answer = args.answer.trim().slice(0, 600);
    if (!answer) throw new Error("INVALID_ARGUMENT: an answer is required.");
    const now = Date.now();
    const asked = mission.clarification ?? null;

    const factId = await ctx.db.insert("contextFacts", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      category: "clarification",
      value: answer,
      sourceType: "user_input",
      sourceReference: asked,
      confidence: 1,
      verificationStatus: "user_confirmed",
      visibility: "workspace",
      createdAt: now,
      updatedAt: now,
    });
    // The question is answered, so it must not be asked again on the re-run.
    await ctx.db.patch(mission._id, { clarification: undefined, updatedAt: now });
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (run) {
      await ctx.db.insert("runEvents", {
        missionId: args.missionId,
        runId: run._id,
        type: "clarification.answered",
        stage: "intake" as Stage,
        safeSummary: asked ? `Answered: ${asked}` : "Clarification answered.",
        createdAt: now,
      });
    }

    // Resume: the classifier re-runs from `intake` with the new fact in hand.
    let resumed = false;
    if (run) {
      try {
        await ctx.runMutation(internal.runs.transition, {
          missionId: args.missionId, targetStage: "intake", targetStatus: "active",
          interruption: null, eventType: "clarification.resumed",
          safeSummary: "Answer recorded as confirmed context — Radar is continuing.",
        });
        resumed = true;
      } catch {
        resumed = false;
      }
      if (resumed) {
        await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
      }
    }
    return { factId, resumed };
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
    await validateWorkspace(ctx, args.workspaceId);
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
    await validateWorkspace(ctx, args.workspaceId);
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
    await validateWorkspace(ctx, args.workspaceId);
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

/** User reviews the AI-generated plan and approves it to start discovery. */
export const approvePlan = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE");
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) throw new Error("Run not found.");
    if (run.status !== "waiting" || run.currentStage !== "plan_review") throw new Error("INVALID_STATE: can only approve from plan_review.");
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: "discover", targetStatus: "active",
      interruption: null, eventType: "plan.approved", safeSummary: "User approved the plan — starting discovery.",
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return null;
  },
});

/** User reviews the discovery summary and tells Radar to continue to evaluation. */
export const continueAfterCheckIn = mutation({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await validateWorkspace(ctx, args.workspaceId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) throw new Error("FORBIDDEN_SCOPE");
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", args.missionId)).first();
    if (!run) throw new Error("Run not found.");
    if (run.status !== "waiting" || run.currentStage !== "check_in") throw new Error("INVALID_STATE: can only continue from check_in.");
    await ctx.runMutation(internal.runs.transition, {
      missionId: args.missionId, targetStage: "evaluate", targetStatus: "active",
      interruption: null, eventType: "checkin.continued", safeSummary: "User confirmed — proceeding to evaluation.",
    });
    await ctx.scheduler.runAfter(0, internal.missionOrchestrator.runStage, { missionId: args.missionId });
    return null;
  },
});
