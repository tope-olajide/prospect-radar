import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const missionMode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const intentLabel = v.union(
  v.literal("find_opportunity"), v.literal("find_person"), v.literal("find_solution"),
  v.literal("find_customer"), v.literal("find_collaborator"), v.literal("find_service"),
  v.literal("find_client"), v.literal("find_provider"), v.literal("find_business"),
);
const targetEntity = v.union(v.literal("person"), v.literal("organization"), v.literal("product_or_service"), v.literal("mixed"));
const intentObject = v.object({
  primary: intentLabel,
  secondary: v.union(intentLabel, v.null()),
  confidence: v.number(),
  rationale: v.string(),
});
const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));
const runStatus = v.union(v.literal("queued"), v.literal("active"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("cancelled"));
const runStage = v.union(v.literal("intake"), v.literal("interpret"), v.literal("plan"), v.literal("discover"), v.literal("evaluate"), v.literal("approval"), v.literal("execute"), v.literal("wait"), v.literal("complete"));
const sourceType = v.union(v.literal("search_result"), v.literal("scraped_page"), v.literal("crawled_page"), v.literal("mapped_site"));
const dataSourceKind = v.union(v.literal("file"), v.literal("website"), v.literal("snippet"));
const dataSourceCrawlMode = v.union(v.literal("crawl"), v.literal("sitemap"), v.literal("single"));
const dataSourceStatus = v.union(v.literal("syncing"), v.literal("ready"), v.literal("failed"), v.literal("archived"));
const sourceProcessingStatus = v.union(v.literal("discovered"), v.literal("scraping"), v.literal("scraped"), v.literal("failed"));
const sourceFreshness = v.union(
  v.literal("fresh"),
  v.literal("cached"),
  v.literal("truncated"),
  v.literal("failed"),
);
const researchJobStatus = v.union(v.literal("running"), v.literal("complete"), v.literal("failed"));
const researchOperation = v.union(v.literal("search"), v.literal("scrape"), v.literal("map"), v.literal("crawl"));
const crawlStatus = v.union(v.literal("scraping"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"));
const planProvider = v.union(v.literal("openai"), v.literal("dashscope"));
const matchLabel = v.union(v.literal("stronger"), v.literal("promising"), v.literal("uncertain"), v.literal("insufficient"));
const actionStatus = v.union(v.literal("draft"), v.literal("awaiting_approval"), v.literal("approved"), v.literal("executing"), v.literal("sent"), v.literal("delivered"), v.literal("failed"), v.literal("cancelled"), v.literal("unverified"));
const approvalStatus = v.union(v.literal("active"), v.literal("used"), v.literal("expired"), v.literal("revoked"));
const outcomeStatus = v.union(v.literal("open"), v.literal("waiting"), v.literal("replied"), v.literal("positive"), v.literal("negative"), v.literal("closed"), v.literal("unknown"));
const factStatus = v.union(v.literal("unreviewed"), v.literal("user_confirmed"), v.literal("user_corrected"), v.literal("user_rejected"));
const factVisibility = v.union(v.literal("mission"), v.literal("workspace"));
const factSource = v.union(v.literal("user_input"), v.literal("plan_extraction"), v.literal("source_extraction"), v.literal("agent_inference"));
const queryKind = v.union(v.literal("search"), v.literal("crawl"));
const queryStatus = v.union(v.literal("pending"), v.literal("done"), v.literal("skipped"));
const entityKind = v.union(v.literal("person"), v.literal("organization"), v.literal("product"));
const contactKind = v.union(v.literal("email"), v.literal("form"), v.literal("linkedin"));
const signalType = v.union(v.literal("hiring"), v.literal("project_request"), v.literal("rfp"), v.literal("complaint"), v.literal("funding"), v.literal("launch"), v.literal("expansion"), v.literal("other"));
const contactRoute = v.object({ kind: contactKind, value: v.string(), publicSource: v.string() });
const pipelineStage = v.union(
  v.literal("contacted"), v.literal("replied"), v.literal("engaged"),
  v.literal("meeting"), v.literal("proposal"), v.literal("won"),
  v.literal("lost"), v.literal("dormant"),
);
const followUpStatus = v.union(
  v.literal("scheduled"), v.literal("due"), v.literal("done"),
  v.literal("snoozed"), v.literal("cancelled"),
);
const sequenceTrigger = v.union(
  v.literal("initial"), v.literal("no_reply"), v.literal("followup_due"), v.literal("reply_classified"),
);
const sequenceStepStatus = v.union(v.literal("pending"), v.literal("draft_ready"), v.literal("sent"), v.literal("skipped"));

// ---- Form intelligence (Phase 4) ----
const formFieldType = v.union(
  v.literal("text"), v.literal("email"), v.literal("tel"), v.literal("url"),
  v.literal("textarea"), v.literal("select"), v.literal("checkbox"), v.literal("radio"),
  v.literal("file"), v.literal("unknown"),
);
const formBlockReason = v.union(
  v.literal("login_required"), v.literal("human_check_required"), v.literal("no_form"),
);
const formProposalStatus = v.union(
  v.literal("draft"), v.literal("awaiting_approval"), v.literal("approved"),
  v.literal("executing"), v.literal("submitted"), v.literal("blocked"), v.literal("failed"),
);
const formSubmissionStatus = v.union(
  v.literal("submitted"), v.literal("blocked_login"),
  v.literal("blocked_human_check"), v.literal("failed"),
);
const formField = v.object({
  name: v.string(), label: v.string(), type: formFieldType, required: v.boolean(),
  options: v.array(v.string()), selector: v.string(), placeholder: v.string(),
});
const formFieldValue = v.object({
  name: v.string(), label: v.string(), value: v.string(),
  factId: v.union(v.id("contextFacts"), v.null()),
  factCategory: v.union(v.string(), v.null()),
});

export default defineSchema({
  missions: defineTable({
    workspaceId: v.string(), title: v.string(), rawGoal: v.string(), mode: missionMode,
    intent: v.optional(intentObject), targetEntity: v.optional(targetEntity),
    relationshipGoal: v.optional(v.string()),
    status: missionStatus, constraints: v.array(v.string()), sourceScope: v.string(),
    completionPredicate: v.string(), clarification: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"]).index("by_workspaceId_and_status", ["workspaceId", "status"]),
  missionPlans: defineTable({
    missionId: v.id("missions"), normalizedGoal: v.string(), mode: missionMode,
    strategyNotes: v.optional(v.string()),
    // Set when the user edits the agent's plan, so the UI can show which parts
    // of the brief are the agent's proposal and which are the user's decision.
    userEditedAt: v.optional(v.number()),
    mustHave: v.array(v.string()), niceToHave: v.array(v.string()), exclusions: v.array(v.string()),
    missingFacts: v.array(v.string()), recommendedSources: v.array(v.string()), proposedSteps: v.array(v.string()),
    completionPredicate: v.string(), provider: planProvider, model: v.string(), createdAt: v.number(),
  }).index("by_missionId", ["missionId"]),
  agentRuns: defineTable({
    missionId: v.id("missions"), status: runStatus, currentStage: runStage,
    // Denormalized so the command center can count active runs in one indexed
    // query instead of joining every mission. Optional: rows created before
    // this field exist stay valid and are backfilled by an internal mutation.
    workspaceId: v.optional(v.string()),
    checkpointVersion: v.number(), activeInterruption: v.union(v.string(), v.null()),
    nextWakeAt: v.union(v.number(), v.null()), retryCount: v.number(),
    startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_and_status", ["workspaceId", "status"])
    // Global status index so the stale-run reaper can sweep every workspace in
    // one bounded query instead of scanning workspaces.
    .index("by_status", ["status"]),
  runEvents: defineTable({
    missionId: v.id("missions"), runId: v.id("agentRuns"), type: v.string(),
    stage: runStage, safeSummary: v.string(), createdAt: v.number(),
  }).index("by_runId", ["runId"]).index("by_missionId", ["missionId"]),
  runSteps: defineTable({
    missionId: v.id("missions"), runId: v.id("agentRuns"), stage: runStage,
    label: v.string(), summary: v.string(), reference: v.union(v.string(), v.null()),
    errorCode: v.union(v.string(), v.null()), tool: v.optional(v.string()), createdAt: v.number(),
  }).index("by_runId", ["runId"]).index("by_missionId", ["missionId"]),
  missionQueries: defineTable({
    missionId: v.id("missions"), query: v.string(), kind: queryKind, status: queryStatus,
    resultCount: v.union(v.number(), v.null()), createdAt: v.number(),
  }).index("by_missionId", ["missionId"]).index("by_missionId_and_status", ["missionId", "status"]),
  contextFacts: defineTable({
    workspaceId: v.string(), missionId: v.union(v.id("missions"), v.null()),
    category: v.string(), value: v.string(), sourceType: factSource,
    sourceReference: v.union(v.string(), v.null()), confidence: v.number(),
    verificationStatus: factStatus, visibility: factVisibility,
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_and_category", ["workspaceId", "category"])
    .index("by_missionId", ["missionId"]),

  researchJobs: defineTable({
    missionId: v.id("missions"), runId: v.id("agentRuns"), requestId: v.string(),
    operation: researchOperation, query: v.string(), status: researchJobStatus, provider: v.literal("firecrawl"),
    providerRequestId: v.union(v.string(), v.null()), resultCount: v.number(),
    crawlId: v.union(v.string(), v.null()), crawlStatus: v.union(crawlStatus, v.null()),
    errorCode: v.union(v.string(), v.null()),
    errorSummary: v.union(v.string(), v.null()), createdAt: v.number(),
    startedAt: v.number(), finishedAt: v.union(v.number(), v.null()), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_crawlId", ["crawlId"])
    .index("by_missionId_and_status", ["missionId", "status"])
    .index("by_missionId_and_requestId", ["missionId", "requestId"]),
  sourceRecords: defineTable({
    missionId: v.id("missions"), jobId: v.id("researchJobs"), url: v.string(), title: v.string(),
    sourceType, excerpt: v.string(), content: v.union(v.string(), v.null()), fetchedAt: v.number(),
    freshness: sourceFreshness, firecrawlRequestId: v.union(v.string(), v.null()),
    firecrawlPageId: v.union(v.string(), v.null()), processingStatus: sourceProcessingStatus,
    errorSummary: v.union(v.string(), v.null()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_missionId_and_url", ["missionId", "url"]),
  discoveries: defineTable({
    missionId: v.id("missions"), sourceId: v.id("sourceRecords"), subject: v.string(),
    signal: v.string(), publishedAt: v.union(v.number(), v.null()),
    extractedFields: v.array(v.object({ key: v.string(), value: v.string() })),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"]).index("by_sourceId", ["sourceId"]),
  matches: defineTable({
    missionId: v.id("missions"), discoveryId: v.id("discoveries"), sourceId: v.id("sourceRecords"),
    label: matchLabel, positiveEvidence: v.array(v.string()), unknowns: v.array(v.string()),
    risks: v.array(v.string()), freshness: v.string(), recommendedAction: v.string(),
    explanationSummary: v.optional(v.string()), explanationProvider: v.optional(planProvider),
    explanationModel: v.optional(v.string()), explainedAt: v.optional(v.number()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_discoveryId", ["discoveryId"])
    .index("by_sourceId", ["sourceId"]),

  entities: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), sourceId: v.id("sourceRecords"),
    kind: entityKind, name: v.string(), nameLower: v.string(), canonicalUrl: v.string(),
    // Denormalized searchable text (name, need, offer, summary). Convex search
    // indexes cover a single field, so the fields are combined here instead of
    // running three searches.
    searchText: v.optional(v.string()),
    attributes: v.array(v.object({ key: v.string(), value: v.string() })),
    summary: v.string(), expressedNeed: v.optional(v.string()), skillsOrOffer: v.array(v.string()),
    contactRoute: v.optional(contactRoute),
    extractionStatus: v.union(v.literal("extracted"), v.literal("snippet_only")),
    confidence: v.number(), firstSeenAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_missionId_and_canonicalUrl", ["missionId", "canonicalUrl"])
    .index("by_missionId_and_nameLower", ["missionId", "nameLower"])
    .index("by_sourceId", ["sourceId"])
    .index("by_workspaceId", ["workspaceId"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["workspaceId"] }),
  entitySignals: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), entityId: v.id("entities"),
    type: signalType, statement: v.string(), evidenceUrl: v.string(),
    observedAt: v.union(v.number(), v.null()), confidence: v.number(), createdAt: v.number(),
  }).index("by_entityId", ["entityId"])
    .index("by_missionId", ["missionId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_entityId_and_evidenceUrl", ["entityId", "evidenceUrl"]),

  agentInboxes: defineTable({
    workspaceId: v.string(), agentmailInboxId: v.string(), email: v.string(),
    displayName: v.union(v.string(), v.null()), clientRequestId: v.optional(v.string()), webhookId: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"]).index("by_agentmailInboxId", ["agentmailInboxId"])
    .index("by_workspaceId_and_clientRequestId", ["workspaceId", "clientRequestId"]),
  actionDrafts: defineTable({
    missionId: v.id("missions"), matchId: v.union(v.id("matches"), v.null()),
    workspaceId: v.string(), agentmailInboxId: v.string(), clientRequestId: v.string(),
    providerDraftId: v.union(v.string(), v.null()), recipient: v.string(), subject: v.string(),
    body: v.string(), contentHash: v.string(), capability: v.literal("send_email"),
    status: actionStatus, outboundId: v.union(v.string(), v.null()),
    providerMessageId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()), inReplyTo: v.optional(v.string()),
    errorSummary: v.union(v.string(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_clientRequestId", ["clientRequestId"])
    .index("by_missionId_and_contentHash", ["missionId", "contentHash"])
    .index("by_providerDraftId", ["providerDraftId"])
    .index("by_providerMessageId", ["providerMessageId"])
    .index("by_threadId", ["threadId"]),
  approvals: defineTable({
    // One approval primitive for every side-effecting capability. Exactly one
    // of actionId (email send) or proposalId (form submission) is set, and the
    // approval is always bound to the capability plus a SHA-256 content hash.
    actionId: v.optional(v.id("actionDrafts")),
    proposalId: v.optional(v.id("formProposals")),
    capability: v.union(v.literal("send_email"), v.literal("submit_form")),
    recipient: v.string(),
    contentHash: v.string(), approvedBy: v.string(), status: approvalStatus, expiresAt: v.number(),
    createdAt: v.number(), resolvedAt: v.union(v.number(), v.null()),
  }).index("by_actionId", ["actionId"]).index("by_proposalId", ["proposalId"]),
  inboxThreads: defineTable({
    workspaceId: v.string(), agentmailInboxId: v.string(), missionId: v.union(v.id("missions"), v.null()),
    matchId: v.union(v.id("matches"), v.null()), threadId: v.string(), labels: v.array(v.string()),
    senderSummary: v.string(), subject: v.string(), preview: v.string(), latestMessageAt: v.number(),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_threadId", ["threadId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_missionId", ["missionId"]),
  inboxMessages: defineTable({
    workspaceId: v.string(), agentmailInboxId: v.string(), missionId: v.union(v.id("missions"), v.null()),
    threadId: v.string(), messageId: v.string(), eventId: v.string(), direction: v.union(v.literal("received"), v.literal("sent")),
    sender: v.string(), recipients: v.array(v.string()), subject: v.string(), preview: v.string(),
    searchText: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_eventId", ["eventId"])
    .index("by_messageId", ["messageId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_threadId", ["threadId"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["workspaceId"] }),
  providerEvents: defineTable({
    provider: v.literal("agentmail"), eventId: v.string(), eventType: v.string(), createdAt: v.number(),
  }).index("by_provider_and_eventId", ["provider", "eventId"]),
  replyClassifications: defineTable({
    messageId: v.id("inboxMessages"), missionId: v.union(v.id("missions"), v.null()), threadId: v.string(),
    label: v.union(v.literal("interested"), v.literal("needs_info"), v.literal("not_now"), v.literal("referral"), v.literal("negative"), v.literal("unknown")),
    confidence: v.number(), summary: v.string(), suggestedNextAction: v.string(),
    suggestedDraftId: v.union(v.id("actionDrafts"), v.null()), provider: planProvider, model: v.string(),
    createdAt: v.number(),
  }).index("by_messageId", ["messageId"]).index("by_missionId", ["missionId"]),
  outcomes: defineTable({
    workspaceId: v.string(),
    missionId: v.id("missions"), matchId: v.union(v.id("matches"), v.null()),
    actionId: v.union(v.id("actionDrafts"), v.null()), counterpart: v.string(),
    searchText: v.optional(v.string()),
    status: outcomeStatus,
    // Relationship pipeline stage. Optional so pre-pipeline rows keep loading;
    // readers resolve a stage from status when it is absent.
    stage: v.optional(pipelineStage),
    latestEvidence: v.string(), linkedThreadId: v.union(v.string(), v.null()), nextAction: v.string(),
    nextStepAt: v.optional(v.union(v.number(), v.null())),
    completionPredicate: v.string(), timeline: v.array(v.object({ type: v.string(), summary: v.string(), createdAt: v.number(), reference: v.optional(v.union(v.string(), v.null())) })),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_actionId", ["actionId"])
    .index("by_matchId", ["matchId"])
    .index("by_linkedThreadId", ["linkedThreadId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_and_stage", ["workspaceId", "stage"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["workspaceId"] }),
  followUps: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"),
    outcomeId: v.union(v.id("outcomes"), v.null()), matchId: v.union(v.id("matches"), v.null()),
    threadId: v.union(v.string(), v.null()), note: v.string(), dueAt: v.number(),
    status: followUpStatus,
    source: v.union(v.literal("user"), v.literal("agent")),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_outcomeId", ["outcomeId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_status_and_dueAt", ["status", "dueAt"]),
  meetings: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"),
    outcomeId: v.union(v.id("outcomes"), v.null()), matchId: v.union(v.id("matches"), v.null()),
    counterpart: v.string(), scheduledAt: v.number(), notes: v.string(), createdBy: v.string(),
    createdAt: v.number(),
  }).index("by_missionId", ["missionId"]).index("by_outcomeId", ["outcomeId"]),
  outreachSequences: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), matchId: v.id("matches"),
    agentmailInboxId: v.string(),
    steps: v.array(v.object({
      index: v.number(), intent: v.string(), trigger: sequenceTrigger,
      status: sequenceStepStatus, draftId: v.union(v.id("actionDrafts"), v.null()),
      queuedAt: v.union(v.number(), v.null()),
    })),
    status: v.union(v.literal("active"), v.literal("complete"), v.literal("cancelled")),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_matchId", ["matchId"])
    .index("by_missionId_and_status", ["missionId", "status"]),

  // Scouted public forms: structure only, never credentials. A blockedReason
  // marks a boundary Radar detects and refuses to cross.
  formTemplates: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), sourceId: v.id("sourceRecords"),
    url: v.string(), formTitle: v.string(), submitLabel: v.string(), submitSelector: v.string(),
    fields: v.array(formField),
    blockedReason: v.union(formBlockReason, v.null()), blockedDetail: v.string(),
    confidence: v.number(), scoutedAt: v.number(), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_sourceId", ["sourceId"])
    .index("by_missionId_and_url", ["missionId", "url"])
    .index("by_workspaceId", ["workspaceId"]),

  // A proposed mapping of confirmed facts onto the scouted fields. The payload
  // hash binds an approval to the exact values shown to the user.
  formProposals: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), templateId: v.id("formTemplates"),
    sourceId: v.id("sourceRecords"), url: v.string(), formTitle: v.string(),
    fieldValues: v.array(formFieldValue),
    unmatchedRequired: v.array(v.string()),
    payloadHash: v.string(), status: formProposalStatus,
    errorSummary: v.union(v.string(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_templateId", ["templateId"])
    .index("by_sourceId", ["sourceId"])
    .index("by_workspaceId", ["workspaceId"]),

  // Provider-credit accounting. `workspaceBudgets` holds the hard cap;
  // `creditCharges` is the ledger. Charges are idempotent by provider
  // reference, so a retried provider call never double-charges.
  workspaceBudgets: defineTable({
    workspaceId: v.string(), creditLimit: v.number(), updatedAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"]),
  creditCharges: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"),
    kind: v.union(v.literal("search"), v.literal("crawl"), v.literal("scrape"), v.literal("extract")),
    amount: v.number(), reference: v.string(), createdAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_and_reference", ["workspaceId", "reference"])
    .index("by_missionId", ["missionId"]),

  // The immutable record of what actually happened: one approval = one row.
  formSubmissions: defineTable({
    workspaceId: v.string(), missionId: v.id("missions"), proposalId: v.id("formProposals"),
    templateId: v.id("formTemplates"), url: v.string(), formTitle: v.string(),
    fieldCount: v.number(),
    status: formSubmissionStatus,
    errorCode: v.union(v.string(), v.null()), errorSummary: v.union(v.string(), v.null()),
    evidenceFileId: v.union(v.id("_storage"), v.null()),
    postSubmitExcerpt: v.string(),
    submittedAt: v.union(v.number(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"])
    .index("by_proposalId", ["proposalId"])
    .index("by_workspaceId", ["workspaceId"]),

  /**
   * User-supplied data sources — the user's side of the evidence ledger. The
   * public web tells Radar what the world wants; these sources tell it what the
   * user offers. One row per source: an uploaded file (text extracted from the
   * stored blob), a website crawled with Firecrawl, or a pasted snippet.
   * `active` sources are gated into the agent's plan, match-explanation, and
   * drafting prompts; `archived` sources are kept but excluded.
   */
  dataSources: defineTable({
    workspaceId: v.string(),
    kind: dataSourceKind,
    title: v.string(),
    /** Website only: where the crawl starts. */
    url: v.union(v.string(), v.null()),
    /** Website only: crawl mode. */
    crawlMode: dataSourceCrawlMode,
    /** Website only: Firecrawl crawl id for progress and re-syncs. */
    crawlId: v.union(v.string(), v.null()),
    /** File only: Convex storage id of the uploaded blob. */
    fileId: v.union(v.id("_storage"), v.null()),
    /** Snippet/file only: the user's own text, bounded. */
    text: v.union(v.string(), v.null()),
    status: dataSourceStatus,
    /** Website only: count of pages ingested by the latest crawl. */
    pageCount: v.number(),
    /** Website only: last successful sync, for the auto-resync cadence. */
    lastSyncedAt: v.union(v.number(), v.null()),
    /** Website only: why the last sync failed, if it did. */
    syncError: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_and_kind", ["workspaceId", "kind"])
    .index("by_crawlId", ["crawlId"]),

  /**
   * Bounded, searchable chunks of a data source. The agent reads chunks, never
   * whole documents — the same bounding rule applied to untrusted web content.
   * `searchText` feeds a Convex search index so mission planning can retrieve
   * only the chunks relevant to the goal.
   */
  dataSourceChunks: defineTable({
    workspaceId: v.string(), sourceId: v.id("dataSources"), ordinal: v.number(),
    text: v.string(), searchText: v.string(),
  })
    .index("by_sourceId", ["sourceId"])
    .index("by_workspaceId", ["workspaceId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["workspaceId"],
    }),
});
