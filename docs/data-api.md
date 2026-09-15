# Data and API contracts

## 1. Contract rules

Convex is the application API. Public functions use object-form arguments and
validators. Components are wrapped by application-owned functions that enforce
identity, scope, policy, and rate limits.

Every state-changing operation is idempotent where a retry could repeat a side
effect. Every external reference is stored with provider, operation, timestamp,
and verification source.

## 2. Core enums

MissionMode: opportunity | person | customer | solution | collaborator.

MissionStatus: draft | ready | running | waiting | blocked | complete | failed | expired | cancelled.

RunStage: intake | interpret | context_check | plan | discover | normalize |
evaluate | research | prepare | approval | execute | verify | wait | follow_up |
complete.

SourceType: search_result | scraped_page | crawl_page | user_url | inbox_message.

VerificationStatus: unreviewed | user_confirmed | user_corrected | user_rejected | stale.

ActionStatus: draft | awaiting_approval | approved | executing | sent | delivered |
failed | cancelled | unverified.

## 3. Domain entities

### Mission

A Mission contains missionId, workspaceId, title, rawGoal, mode, constraints,
sourceScope, completionPredicate, autonomyPolicy, status, createdAt, and updatedAt.

### MissionPlan

A MissionPlan contains normalizedGoal, mode, mustHave, niceToHave, exclusions,
missingFacts, recommendedSources, proposedSteps, and completionPredicate. It is
created by OpenAI and must be user-editable before research begins.

### ContextFact

A ContextFact contains factId, workspaceId, category, value, sourceReference,
confidence, verificationStatus, visibility, and freshness.

### SourceRecord

A SourceRecord contains sourceId, missionId, url, title, sourceType, excerpt,
evidenceSpans, fetchedAt, freshness, firecrawlJobId, firecrawlPageId,
processingStatus, and errorSummary.

### Discovery

A Discovery contains discoveryId, missionId, sourceId, subject, signal,
publishedAt, extractedFields, and provenance.

### Match

A Match contains matchId, missionId, discoveryId, label, positiveEvidence,
unknowns, risks, freshness, sourceReferences, feedback, and recommendedAction.

The label is stronger, promising, uncertain, or insufficient. Numeric scores may
be stored for sorting but are never shown as factual probability.

### AgentRun

An AgentRun contains runId, missionId, status, currentStage, checkpointVersion,
steps, activeInterruption, nextWakeAt, retryCount, startedAt, and finishedAt.

Each step records inputReference, outputReference, attemptCount, status,
startedAt, finishedAt, and safeSummary.

### ActionDraft

An ActionDraft contains actionId, missionId, matchId, type, recipient, subject,
body, contextUsed, assumptions, sideEffects, contentHash, status, and createdAt.

### Approval

An Approval contains approvalId, actionId, capability, recipient, contentHash,
contextSnapshotId, approvedBy, status, expiresAt, and resolvedAt.

### InboxLink

An InboxLink contains workspaceId, agentmailInboxId, missionId, matchId,
threadId, consentScope, labels, and lastSeenAt. Full message bodies remain in
the AgentMail component.

### Outcome

An Outcome contains outcomeId, missionId, matchId, counterpart, status,
latestEvidence, linkedThreadId, nextAction, completionPredicate, timeline, and
updatedAt.

## 4. Function namespaces

### Query namespace

- missions.list and missions.get;
- matches.list and matches.get;
- runs.get and runs.events;
- research.getCrawl and research.listPages;
- inbox.listThreads and inbox.getThread;
- outcomes.list and outcomes.get;
- network.getProjection.

### Mutation namespace

- missions.create, missions.update, missions.start;
- context.confirmFact, context.rejectFact, context.deleteSource;
- actions.saveDraft, actions.approve, actions.reject, actions.cancel;
- runs.respond, runs.pause, runs.resume, runs.cancel;
- inbox.setLabel;
- outcomes.updateStatus;
- network.publishProfile, network.publishPost, network.respondToInvitation,
  network.grantDisclosure.

### Action namespace

- ai.interpretMission;
- ai.extractFacts;
- ai.explainMatches;
- ai.draftMessage;
- ai.classifyReply;
- research.search;
- research.scrape;
- research.map;
- research.startCrawl;
- research.normalizePages;
- inbox.processInboundMessage.

## 5. Provider references

Every Firecrawl reference stores the operation, query or URL, job ID when
available, page ID when available, source URL, fetched time, and processing
status.

Every AgentMail reference stores inbox ID, thread ID, message ID or outbound ID,
event ID when available, delivery state, and timestamp.

Every OpenAI call stores task name, model configuration label, schema name, result
status, refusal or error class, and safe output summary. Raw prompts and private
message bodies are not written to public evidence.

## 6. State transitions

A mission can move from draft to ready to running. A run can move to waiting when
it needs approval, permission, missing information, or an external reply. Only
verification or the explicit completion predicate can move it to complete.

An action can move from draft to awaiting_approval to approved to executing.
Provider confirmation moves it to sent or delivered. A provider error moves it to
failed or unverified; it never becomes delivered by inference.

An approval is valid only if action type, recipient, content hash, capability,
context snapshot, and expiry still match.

## 7. Error classes

- INVALID_ARGUMENT;
- AUTH_REQUIRED;
- FORBIDDEN_SCOPE;
- SOURCE_UNAVAILABLE;
- SOURCE_STALE;
- FIRECRAWL_RATE_LIMITED;
- FIRECRAWL_CREDITS_EXHAUSTED;
- PAGE_TRUNCATED;
- OPENAI_REFUSAL;
- OPENAI_SCHEMA_INVALID;
- AGENTMAIL_WEBHOOK_INVALID;
- AGENTMAIL_DELIVERY_FAILED;
- APPROVAL_REQUIRED;
- APPROVAL_STALE;
- DUPLICATE_EVENT;
- IDEMPOTENCY_CONFLICT;
- NO_RELIABLE_MATCH;
- RUN_NOT_RESUMABLE.

Errors include a user-safe message, retryability, request ID, and next action.

## 8. Event vocabulary

Events include:

- mission.created;
- run.created, run.stage_started, run.stage_completed, run.waiting, run.resumed;
- source.requested, source.ready, source.failed;
- crawl.started, crawl.page_ready, crawl.completed;
- match.created, match.updated, match.feedback_recorded;
- action.drafted, action.approval_required, action.approved;
- action.sent, action.delivered, action.failed, action.unverified;
- inbox.thread_updated, inbox.reply_received;
- outcome.created, outcome.updated, outcome.completed;
- network.profile_published, network.post_published, network.consent_changed.

Events are append-only application facts. UI projections subscribe to Convex
queries over the relevant records.

## 9. Verification requirements

A feature is not complete because a function returns successfully. Verification
must show:

- the provider response or webhook was real;
- the resulting external ID was stored;
- the UI can reload and display the result;
- a retry does not duplicate the side effect;
- the failure path is visible and actionable.

## 10. Test contracts

Tests must cover:

- validator rejection and authorization boundaries;
- mission schema parsing and model refusal;
- source provenance and stale-source behavior;
- approval bypass and changed-content rejection;
- webhook signature and duplicate-event handling;
- AgentMail delivery-state transitions;
- crawl completion and normalization exactly once;
- retry idempotency;
- outcome persistence after reload.
