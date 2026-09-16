import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { searchableText } from "../convex/hash";

const convexModules = import.meta.glob("../convex/**/*.ts");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

/**
 * Every public query, called against a fully populated workspace.
 *
 * A live proof run caught `runs.forMission/events/steps` returning raw database
 * documents (with `_creationTime` and other table-only fields) against narrower
 * view validators: every production call raised `ReturnsValidationError` and the
 * Activity panel silently showed "no run" instead of an error. No test noticed,
 * because the tests read the tables directly instead of through the public
 * functions the app actually calls. This suite closes that gap for good.
 */
async function seedWorkspace(t: TestT) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const { missionId, runId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Find companies that need React development.",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists.",
    });

    await ctx.runMutation(internal.plans.save, {
      missionId,
      normalizedGoal: "Find companies that need React development.",
      mode: "opportunity",
      mustHave: ["needs React work"],
      niceToHave: ["hiring signal"],
      exclusions: ["staffing agencies"],
      missingFacts: ["budget"],
      recommendedSources: ["company career pages"],
      proposedSteps: ["search", "evaluate"],
      completionPredicate: "A user-approved next action exists.",
      provider: "openai",
      model: "test-model",
    });

    const factId = await ctx.runMutation(api.context.add, {
      workspaceId: WORKSPACE,
      missionId,
      category: "my skills",
      value: "React, TypeScript",
      sourceType: "user_input",
      sourceReference: null,
      confidence: 1,
      visibility: "workspace",
    });

    const jobId = await ctx.db.insert("researchJobs", {
      missionId, runId, requestId: "req-1", operation: "search", query: "react agency",
      status: "complete", provider: "firecrawl", providerRequestId: "fc-1", resultCount: 1,
      crawlId: null, crawlStatus: null, errorCode: null, errorSummary: null,
      createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId, jobId, url: "https://acme.example.com/about", title: "Acme Corp",
      sourceType: "scraped_page", excerpt: "Acme needs a frontend engineer.",
      content: "Acme Corp is hiring a frontend engineer.", fetchedAt: now, freshness: "fresh",
      firecrawlRequestId: "fc-1", firecrawlPageId: "page-1", processingStatus: "scraped",
      errorSummary: null, createdAt: now, updatedAt: now,
    });
    const discoveryId = await ctx.db.insert("discoveries", {
      missionId, sourceId, subject: "Acme Corp", signal: "hiring",
      publishedAt: null, extractedFields: [{ key: "stack", value: "React" }],
      createdAt: now, updatedAt: now,
    });
    const matchId = await ctx.db.insert("matches", {
      missionId, discoveryId, sourceId, label: "promising", positiveEvidence: ["hiring a frontend engineer"],
      unknowns: ["budget"], risks: [],
      freshness: "fresh", recommendedAction: "contact", createdAt: now, updatedAt: now,
    });
    const entityId = await ctx.db.insert("entities", {
      workspaceId: WORKSPACE, missionId, sourceId, kind: "organization",
      name: "Acme Corp", nameLower: "acme", canonicalUrl: "https://acme.example.com/about",
      searchText: searchableText(["Acme Corp", "Acme needs a frontend engineer.", "React"]),
      attributes: [{ key: "industry", value: "climate" }],
      summary: "Climate analytics company rebuilding its dashboard.",
      expressedNeed: "Needs a frontend engineer", skillsOrOffer: ["React dashboards"],
      contactRoute: { kind: "email", value: "hello@acme.example.com", publicSource: "https://acme.example.com/contact" },
      extractionStatus: "extracted", confidence: 0.9, firstSeenAt: now, updatedAt: now,
    });
    await ctx.db.insert("entitySignals", {
      workspaceId: WORKSPACE, missionId, entityId, type: "hiring",
      statement: "Acme Corp is hiring a frontend engineer.",
      evidenceUrl: "https://acme.example.com/about", observedAt: now, confidence: 0.9, createdAt: now,
    });

    await ctx.db.insert("agentInboxes", {
      workspaceId: WORKSPACE, agentmailInboxId: "inbox_test", email: "radar@agentmail.example",
      displayName: "Prospect Radar", createdAt: now, updatedAt: now,
    });
    const actionId = await ctx.db.insert("actionDrafts", {
      missionId, matchId, workspaceId: WORKSPACE, agentmailInboxId: "inbox_test",
      clientRequestId: "draft-1", providerDraftId: null, recipient: "hello@acme.example.com",
      subject: "Frontend help for Acme", body: "Hello, I build React dashboards and would like to help.",
      contentHash: "hash-1", capability: "send_email", status: "draft", outboundId: null,
      providerMessageId: null, threadId: null, errorSummary: null, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("approvals", {
      actionId, capability: "send_email", recipient: "hello@acme.example.com", contentHash: "hash-1",
      approvedBy: WORKSPACE, status: "active", expiresAt: now + 3600_000, createdAt: now, resolvedAt: null,
    });

    const threadId = "thread-1";
    await ctx.db.insert("inboxThreads", {
      workspaceId: WORKSPACE, agentmailInboxId: "inbox_test", missionId, matchId, threadId,
      labels: ["replied"], senderSummary: "Acme Corp", subject: "Re: Frontend help for Acme",
      preview: "Yes, let's talk.", latestMessageAt: now, createdAt: now, updatedAt: now,
    });
    const messageId = await ctx.db.insert("inboxMessages", {
      workspaceId: WORKSPACE, agentmailInboxId: "inbox_test", missionId, threadId,
      messageId: "msg-1", eventId: "event-1", direction: "received", sender: "hello@acme.example.com",
      recipients: ["radar@agentmail.example"], subject: "Re: Frontend help for Acme",
      preview: "Yes, let's talk.", searchText: searchableText(["hello@acme.example.com", "Re: Frontend help for Acme", "Yes, let's talk."]),
      createdAt: now,
    });
    await ctx.db.insert("replyClassifications", {
      messageId, missionId, threadId, label: "interested", confidence: 0.8,
      summary: "They want to talk.", suggestedNextAction: "Propose a call.",
      suggestedDraftId: null, provider: "openai", model: "test-model", createdAt: now,
    });

    const outcomeId = await ctx.db.insert("outcomes", {
      workspaceId: WORKSPACE, missionId, matchId, actionId, counterpart: "hello@acme.example.com",
      searchText: searchableText(["hello@acme.example.com", "Acme replied asking for a call.", "Propose a call."]),
      status: "replied", stage: "replied", latestEvidence: "Acme replied asking for a call.",
      linkedThreadId: threadId, nextAction: "Propose a call.", nextStepAt: null,
      completionPredicate: "A user-approved next action exists.",
      timeline: [{ type: "inbox.reply_received", summary: "Acme replied.", createdAt: now }],
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("followUps", {
      workspaceId: WORKSPACE, missionId, outcomeId, matchId, threadId, note: "Follow up with Acme",
      dueAt: now - 1000, status: "due", source: "agent", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("meetings", {
      workspaceId: WORKSPACE, missionId, outcomeId, matchId, counterpart: "hello@acme.example.com",
      scheduledAt: now + 86_400_000, notes: "Intro call", createdBy: WORKSPACE, createdAt: now,
    });
    await ctx.db.insert("outreachSequences", {
      workspaceId: WORKSPACE, missionId, matchId, agentmailInboxId: "inbox_test",
      steps: [{ index: 0, intent: "intro", trigger: "initial", status: "sent", draftId: actionId, queuedAt: now }],
      status: "active", createdAt: now, updatedAt: now,
    });

    const templateId = await ctx.db.insert("formTemplates", {
      workspaceId: WORKSPACE, missionId, sourceId, url: "https://acme.example.com/contact",
      formTitle: "Contact Acme", submitLabel: "Send", submitSelector: "form button",
      fields: [{ name: "email", label: "Email", type: "email", required: true, options: [], selector: 'input[name="email"]', placeholder: "" }],
      blockedReason: null, blockedDetail: "", confidence: 0.9, scoutedAt: now, createdAt: now, updatedAt: now,
    });
    const proposalId = await ctx.db.insert("formProposals", {
      workspaceId: WORKSPACE, missionId, templateId, sourceId, url: "https://acme.example.com/contact",
      formTitle: "Contact Acme",
      fieldValues: [{ name: "email", label: "Email", value: "hello@acme.example.com", factId, factCategory: "my skills" }],
      unmatchedRequired: [], payloadHash: "payload-1", status: "submitted", errorSummary: null,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("formSubmissions", {
      workspaceId: WORKSPACE, missionId, proposalId, templateId, url: "https://acme.example.com/contact",
      formTitle: "Contact Acme", fieldCount: 1, status: "submitted", errorCode: null, errorSummary: null,
      evidenceFileId: null, postSubmitExcerpt: "Thanks!", submittedAt: now, createdAt: now, updatedAt: now,
    });

    return {
      missionId: missionId as unknown as string,
      runId: runId as unknown as string,
      threadId,
      messageId: messageId as unknown as string,
      outcomeId: outcomeId as unknown as string,
    };
  });
}

describe("public query contracts — every query the app calls", () => {
  it("returns validator-valid results for a fully populated workspace", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, runId, threadId, messageId, outcomeId } = await seedWorkspace(t);

    // Missions, plans, runs.
    expect((await t.query(api.missions.list, { workspaceId: WORKSPACE })).length).toBe(1);
    expect(await t.query(api.plans.getForMission, { missionId: missionId as never })).not.toBeNull();
    expect(await t.query(api.runs.forMission, { missionId: missionId as never })).not.toBeNull();
    expect((await t.query(api.runs.events, { runId: runId as never })).length).toBeGreaterThan(0);
    expect(Array.isArray(await t.query(api.runs.steps, { runId: runId as never }))).toBe(true);

    // Research, entities, matches.
    expect((await t.query(api.researchStore.listJobs, { missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.researchStore.listSources, { missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.researchStore.listMatches, { missionId: missionId as never })).length).toBe(1);
    await t.query(api.researchStore.latestCrawlProgress, { missionId: missionId as never });
    expect((await t.query(api.entityStore.listForMission, { missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.entityStore.listSignalsForMission, { missionId: missionId as never })).length).toBe(1);

    // Context, outreach, inbox.
    expect((await t.query(api.context.list, { workspaceId: WORKSPACE, missionId: null })).length).toBe(1);
    expect(await t.query(api.outreachStore.getInbox, { workspaceId: WORKSPACE })).not.toBeNull();
    expect((await t.query(api.outreachStore.listDrafts, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.outreachStore.listClassifications, { workspaceId: WORKSPACE, missionId: null })).length).toBe(1);
    expect((await t.query(api.inbox.listThreads, { workspaceId: WORKSPACE, missionId: null })).length).toBe(1);
    expect((await t.query(api.inbox.listMessages, { workspaceId: WORKSPACE, threadId })).length).toBe(1);

    // Relationships.
    expect((await t.query(api.outcomes.listForMission, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect(await t.query(api.outcomes.getForMission, { workspaceId: WORKSPACE, outcomeId: outcomeId as never })).not.toBeNull();
    expect((await t.query(api.relationships.followUpsForMission, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.relationships.meetingsForMission, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.relationships.sequencesForMission, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);

    // Forms.
    expect((await t.query(api.formStore.listTemplates, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.formStore.listProposals, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    expect((await t.query(api.formStore.listSubmissions, { workspaceId: WORKSPACE, missionId: missionId as never })).length).toBe(1);
    const cap = await t.query(api.formStore.capStatus, { workspaceId: WORKSPACE });
    expect(cap.used).toBe(1);

    // Provider budget (Phase 6): read before every end-to-end run.
    const budget = await t.query(api.budget.status, { workspaceId: WORKSPACE, missionId: missionId as never });
    expect(budget.creditLimit).toBeGreaterThan(0);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(budget.creditLimit);
    expect(budget.breakdown).toEqual({ search: 0, crawl: 0, scrape: 0, extract: 0 });
    expect(await t.query(api.budget.chargesForMission, { workspaceId: WORKSPACE, missionId: missionId as never })).toEqual([]);

    // Command center + system.
    const overview = await t.query(api.commandCenter.overview, { workspaceId: WORKSPACE });
    expect(overview.counts.missions).toBe(1);
    expect(overview.counts.entities).toBe(1);
    expect(overview.counts.signalsThisWeek).toBe(1);
    expect(overview.counts.threads).toBe(1);
    expect(overview.counts.replies).toBe(1);
    expect(overview.counts.followUpsDue).toBe(1);
    expect(overview.counts.submissions).toBe(1);
    expect(overview.pipeline.find((row) => row.stage === "replied")?.count).toBe(1);
    await t.query(api.system.status, {});

    void messageId;
  });

  it("searches across entities, relationships, and messages", async () => {
    const t = convexTest(schema, convexModules);
    await seedWorkspace(t);

    const entityHits = await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "acme" });
    expect(entityHits.some((hit) => hit.kind === "entity" && hit.title === "Acme Corp")).toBe(true);
    expect(entityHits.some((hit) => hit.kind === "relationship")).toBe(true);
    expect(entityHits.some((hit) => hit.kind === "message")).toBe(true);

    const needHits = await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "frontend" });
    expect(needHits.some((hit) => hit.kind === "entity")).toBe(true);

    // A one-character query is refused rather than scanning the index.
    expect(await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "a" })).toEqual([]);
    // Another workspace sees nothing.
    expect(await t.query(api.commandCenter.search, { workspaceId: "attacker", query: "acme" })).toEqual([]);
  });

  it("keeps workspace aggregates scoped to the calling workspace", async () => {
    const t = convexTest(schema, convexModules);
    await seedWorkspace(t);
    const other = await t.query(api.commandCenter.overview, { workspaceId: "attacker" });
    expect(other.counts.missions).toBe(0);
    expect(other.counts.entities).toBe(0);
    expect(other.pipeline.every((row) => row.count === 0)).toBe(true);
  });
});

describe("backfillSearch — legacy rows become searchable", () => {
  it("fills searchText and run workspace scoping, idempotently", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, runId } = await t.run(async (ctx) => {
      const now = Date.now();
      const created = await ctx.runMutation(api.missions.create, {
        workspaceId: WORKSPACE,
        title: "Legacy mission",
        rawGoal: "Legacy mission",
        constraints: [],
        sourceScope: "public-web",
        completionPredicate: "A user-approved next action exists.",
      });
      // Simulate a row written before the field existed.
      const jobId = await ctx.db.insert("researchJobs", {
        missionId: created.missionId, runId: created.runId, requestId: "req-legacy", operation: "search",
        query: "q", status: "complete", provider: "firecrawl", providerRequestId: null, resultCount: 1,
        crawlId: null, crawlStatus: null, errorCode: null, errorSummary: null,
        createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
      });
      const sourceId = await ctx.db.insert("sourceRecords", {
        missionId: created.missionId, jobId, url: "https://legacy.example.com", title: "Legacy Co",
        sourceType: "search_result", excerpt: "e", content: "c", fetchedAt: now, freshness: "fresh",
        firecrawlRequestId: null, firecrawlPageId: null, processingStatus: "scraped", errorSummary: null,
        createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("entities", {
        workspaceId: WORKSPACE, missionId: created.missionId, sourceId, kind: "organization",
        name: "Legacy Co", nameLower: "legacy", canonicalUrl: "https://legacy.example.com",
        attributes: [], summary: "An old row", skillsOrOffer: [],
        extractionStatus: "snippet_only", confidence: 0.3, firstSeenAt: now, updatedAt: now,
      });
      await ctx.db.patch(created.runId, { workspaceId: undefined });
      return { missionId: created.missionId as unknown as string, runId: created.runId as unknown as string };
    });

    const filled = await t.run(async (ctx) => ctx.runMutation(internal.commandCenter.backfillSearch, { workspaceId: WORKSPACE }));
    expect(filled.entities).toBe(1);
    expect(filled.runs).toBe(1);
    expect(await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "legacy" })).not.toHaveLength(0);
    // A freshly created run is `queued`, which means it is waiting for the user,
    // not working — so the overview must report it as ready, not active.
    const overview = await t.query(api.commandCenter.overview, { workspaceId: WORKSPACE });
    expect(overview.counts.runsReady).toBe(1);
    expect(overview.counts.runsActive).toBe(0);

    // Re-running is a no-op.
    const again = await t.run(async (ctx) => ctx.runMutation(internal.commandCenter.backfillSearch, { workspaceId: WORKSPACE }));
    expect(again).toEqual({ entities: 0, outcomes: 0, messages: 0, runs: 0 });
    void missionId;
    void runId;
  });
});
