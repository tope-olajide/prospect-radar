import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * Sequence scheduling lives apart from the relationship store so the store can
 * stay free of references back into the LLM actions (`ai.ts` reads the store).
 *
 * Nothing here sends. A queued step becomes a draft, and a draft still needs
 * the user's approval before it can leave the AgentMail inbox.
 */

/**
 * Queues the next sequence step whose trigger matches.
 *
 * Drafting needs the LLM, so this only schedules the action.
 * `prepareDraft` is idempotent by clientRequestId, so a retried sweep produces
 * the same draft rather than a duplicate.
 */
export const queueNextStep = internalMutation({
  args: { sequenceId: v.id("outreachSequences"), trigger: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get(args.sequenceId);
    if (!sequence || sequence.status !== "active") return null;
    const step = sequence.steps.find((entry) => entry.status === "pending" && entry.trigger === args.trigger)
      ?? sequence.steps.find((entry) => entry.status === "pending");
    if (!step) return null;
    await ctx.scheduler.runAfter(0, internal.ai.draftSequenceStep, {
      sequenceId: sequence._id,
      index: step.index,
    });
    return step.index;
  },
});

/**
 * Marks overdue follow-ups as due and wakes the sequence engine.
 *
 * Runs on a schedule (see `crons.ts`). It never sends anything: a due follow-up
 * produces a draft, and a draft still needs approval.
 */
export const sweepDueFollowUps = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ marked: v.number(), queued: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("followUps")
      .withIndex("by_status_and_dueAt", (q) => q.eq("status", "scheduled").lte("dueAt", now))
      .take(50);
    let queued = 0;
    for (const followUp of due) {
      await ctx.db.patch(followUp._id, { status: "due", updatedAt: now });
      const matchId = followUp.matchId;
      if (!matchId) continue;
      const sequence = await ctx.db.query("outreachSequences")
        .withIndex("by_matchId", (q) => q.eq("matchId", matchId))
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();
      if (!sequence) continue;
      await ctx.scheduler.runAfter(0, internal.sequenceRunner.queueNextStep, {
        sequenceId: sequence._id,
        trigger: "followup_due",
      });
      queued += 1;
    }
    return { marked: due.length, queued };
  },
});
