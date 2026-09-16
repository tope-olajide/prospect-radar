import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { searchableText } from "./hash";

/**
 * Command center: the workspace-level aggregates and the cross-everything
 * search that make Radar usable as a product rather than a form.
 *
 * Every aggregate reads through an index with a bounded `take`, so the Home
 * screen costs a fixed number of queries regardless of how much data the
 * workspace holds. No query here joins per-row.
 */

const pipelineStages = ["contacted", "replied", "engaged", "meeting", "proposal", "won", "lost", "dormant"] as const;

const overviewCounts = v.object({
  missions: v.number(),
  /** Runs with a stage actively executing right now. */
  runsActive: v.number(),
  /** Runs created but not started — they wait for the user, not for us. */
  runsReady: v.number(),
  runsWaiting: v.number(),
  runsBlocked: v.number(),
  entities: v.number(),
  signalsThisWeek: v.number(),
  threads: v.number(),
  replies: v.number(),
  followUpsDue: v.number(),
  draftsPending: v.number(),
  draftsApproved: v.number(),
  submissions: v.number(),
  blockedSubmissions: v.number(),
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 300;

export const overview = query({
  args: { workspaceId: v.string() },
  returns: v.object({
    counts: overviewCounts,
    pipeline: v.array(v.object({ stage: v.string(), count: v.number() })),
  }),
  handler: async (ctx, args) => {
    const workspaceId = args.workspaceId;
    const now = Date.now();

    const [missions, runs, entities, signals, threads, followUps, drafts, outcomes, submissions] = await Promise.all([
      ctx.db.query("missions").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("agentRuns").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("entities").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("entitySignals").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("inboxThreads").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("followUps").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("actionDrafts").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("outcomes").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
      ctx.db.query("formSubmissions").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT),
    ]);

    const counts = {
      missions: missions.length,
      // "Working" must mean a stage is executing. A queued run is idle waiting
      // for the user to start it, so counting it here overstated progress.
      runsActive: runs.filter((run) => run.status === "active").length,
      runsReady: runs.filter((run) => run.status === "queued").length,
      runsWaiting: runs.filter((run) => run.status === "waiting").length,
      runsBlocked: runs.filter((run) => run.status === "blocked").length,
      entities: entities.length,
      signalsThisWeek: signals.filter((signal) => signal.createdAt >= now - WEEK_MS).length,
      threads: threads.length,
      replies: threads.filter((thread) => thread.labels.includes("replied")).length,
      followUpsDue: followUps.filter((item) => item.status === "due" || (item.status === "scheduled" && item.dueAt <= now)).length,
      draftsPending: drafts.filter((draft) => draft.status === "draft" || draft.status === "awaiting_approval").length,
      draftsApproved: drafts.filter((draft) => draft.status === "approved").length,
      submissions: submissions.filter((row) => row.status === "submitted").length,
      blockedSubmissions: submissions.filter((row) => row.status === "blocked_login" || row.status === "blocked_human_check").length,
    };

    const pipeline = pipelineStages.map((stage) => ({
      stage,
      count: outcomes.filter((outcome) => (outcome.stage ?? "contacted") === stage).length,
    }));

    return { counts, pipeline };
  },
});

export const searchResult = v.object({
  kind: v.union(v.literal("entity"), v.literal("relationship"), v.literal("message")),
  id: v.string(),
  title: v.string(),
  detail: v.string(),
  missionId: v.union(v.id("missions"), v.null()),
  view: v.union(v.literal("discover"), v.literal("outcomes"), v.literal("inbox")),
  at: v.number(),
});

/**
 * Command-bar search across entities, relationships, and messages. Convex
 * search indexes cover one field per index, so `searchText` is denormalized at
 * write time and filtered by workspace at read time.
 */
export const search = query({
  args: { workspaceId: v.string(), query: v.string() },
  returns: v.array(searchResult),
  handler: async (ctx, args) => {
    const term = args.query.trim();
    if (term.length < 2) return [];
    const limit = 5;
    const [entities, outcomes, messages] = await Promise.all([
      ctx.db.query("entities")
        .withSearchIndex("search_text", (q) => q.search("searchText", term).eq("workspaceId", args.workspaceId))
        .take(limit),
      ctx.db.query("outcomes")
        .withSearchIndex("search_text", (q) => q.search("searchText", term).eq("workspaceId", args.workspaceId))
        .take(limit),
      ctx.db.query("inboxMessages")
        .withSearchIndex("search_text", (q) => q.search("searchText", term).eq("workspaceId", args.workspaceId))
        .take(limit),
    ]);

    return [
      ...entities.map((entity) => ({
        kind: "entity" as const,
        id: entity._id,
        title: entity.name,
        detail: entity.expressedNeed || entity.summary || entity.kind,
        missionId: entity.missionId,
        view: "discover" as const,
        at: entity.updatedAt,
      })),
      ...outcomes.map((outcome) => ({
        kind: "relationship" as const,
        id: outcome._id,
        title: outcome.counterpart,
        detail: `${outcome.stage ?? "contacted"} · ${outcome.nextAction}`,
        missionId: outcome.missionId,
        view: "outcomes" as const,
        at: outcome.updatedAt,
      })),
      ...messages.map((message) => ({
        kind: "message" as const,
        id: message._id,
        title: message.subject || message.sender,
        detail: `${message.direction} · ${message.preview}`,
        missionId: message.missionId,
        view: "inbox" as const,
        at: message.createdAt,
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 12);
  },
});

/**
 * Backfill for rows written before `searchText` and run `workspaceId` existed.
 * Bounded and idempotent: it only touches rows that are missing the field, and
 * re-running it is a no-op. Scoped to one workspace at a time.
 */
export const backfillSearch = internalMutation({
  args: { workspaceId: v.string() },
  returns: v.object({ entities: v.number(), outcomes: v.number(), messages: v.number(), runs: v.number() }),
  handler: async (ctx, args) => {
    const workspaceId = args.workspaceId;
    let entityCount = 0;
    let outcomeCount = 0;
    let messageCount = 0;
    let runCount = 0;

    const entities = await ctx.db.query("entities").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT);
    for (const entity of entities) {
      if (entity.searchText) continue;
      await ctx.db.patch(entity._id, {
        searchText: searchableText([entity.name, entity.summary, entity.expressedNeed, entity.skillsOrOffer.join(" ")]),
      });
      entityCount += 1;
    }

    const outcomes = await ctx.db.query("outcomes").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT);
    for (const outcome of outcomes) {
      if (outcome.searchText) continue;
      await ctx.db.patch(outcome._id, {
        searchText: searchableText([outcome.counterpart, outcome.latestEvidence, outcome.nextAction]),
      });
      outcomeCount += 1;
    }

    const missions = await ctx.db.query("missions").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).take(SCAN_LIMIT);
    for (const mission of missions) {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", mission._id)).first();
      if (run && !run.workspaceId) {
        await ctx.db.patch(run._id, { workspaceId });
        runCount += 1;
      }
      const messages = await ctx.db.query("inboxThreads").withIndex("by_missionId", (q) => q.eq("missionId", mission._id)).take(20);
      for (const thread of messages) {
        const threadMessages = await ctx.db.query("inboxMessages").withIndex("by_threadId", (q) => q.eq("threadId", thread.threadId)).take(20);
        for (const message of threadMessages) {
          if (message.searchText) continue;
          await ctx.db.patch(message._id, {
            searchText: searchableText([message.sender, message.subject, message.preview]),
          });
          messageCount += 1;
        }
      }
    }

    return { entities: entityCount, outcomes: outcomeCount, messages: messageCount, runs: runCount };
  },
});
