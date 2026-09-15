# Technical architecture

## 1. Architecture decision

Prospect Radar is a React/Vite frontend backed entirely by Convex.

- React/Vite is built as static assets.
- Convex owns application data, typed functions, authorization boundaries,
  durable state, scheduling, and reactive subscriptions.
- Firecrawl and AgentMail are installed as official Convex components.
- OpenAI is called only from server-side Convex actions.
- The frontend is deployed through Convex static hosting at a public convex.site URL.
- There is no separate Node API, relational database, queue service, or browser
  automation dependency in the active architecture.

## 2. Logical topology

Browser
→ Convex queries and mutations
→ Convex actions and scheduler
→ OpenAI Responses API
→ Firecrawl Convex component
→ AgentMail Convex component
→ Convex reactive state

Firecrawl and AgentMail webhooks enter through Convex HTTP routes. Provider
credentials are deployment environment variables and never appear in browser
bundles or mutation arguments.

## 3. Convex component setup

The implementation uses:

- @firecrawl/firecrawl-convex;
- @agentmail/convex;
- the official Convex static hosting component.

Firecrawl configuration requires FIRECRAWL_API_KEY and, for webhook mode,
FIRECRAWL_WEBHOOK_SECRET. AgentMail configuration requires AGENTMAIL_API_KEY
and AGENTMAIL_WEBHOOK_SECRET. AGENTMAIL_BASE_URL is optional for a supported
regional endpoint. OpenAI uses OPENAI_API_KEY unless the project explicitly
uses a verified Convex-managed model gateway.

Component setup belongs in convex/convex.config.ts. The application wrapper
must enforce identity, mission ownership, source scope, rate limits, and
redaction because components cannot make application-level authorization
decisions for the product.

## 4. Application modules

- missions: natural-language goals, mode, constraints, and completion predicates;
- context: facts, sources, provenance, visibility, freshness, and deletion;
- research: Firecrawl calls, crawl jobs, page normalization, and evidence;
- matching: ranking inputs, explanations, feedback, and saved matches;
- agentRuns: stages, checkpoints, interruptions, retries, and receipts;
- actions: drafts, approvals, idempotency, execution, and verification;
- inbox: AgentMail inbox links, labels, threads, and outcome references;
- outcomes: relationship state, next actions, and timelines;
- network: opt-in profiles, opportunity posts, invitations, disclosures, and connections;
- notifications: approval, reply, failure, and completion signals;
- audit: safe, append-only security and side-effect events.

## 5. Convex function boundaries

Queries are read-only and return user-scoped projections:

- missions.list and missions.get;
- matches.list and matches.get;
- runs.get and runs.events;
- research.getCrawl and research.listPages;
- inbox.listThreads and inbox.getThread;
- outcomes.list and outcomes.get;
- network.getProjection.

Mutations perform bounded state transitions:

- missions.create, missions.update, and missions.start;
- context.confirmFact and context.deleteSource;
- actions.saveDraft, actions.approve, actions.reject, and actions.cancel;
- inbox.setLabel and outcomes.updateStatus;
- runs.respond, runs.pause, runs.resume, and runs.cancel;
- network.publishProfile, network.publishPost, network.respondToInvitation,
  and network.grantDisclosure.

Actions call external APIs or the model:

- ai.interpretMission;
- ai.extractFacts;
- ai.explainMatches;
- ai.classifyReply;
- ai.draftMessage;
- research.search;
- research.scrape;
- research.map;
- research.startCrawl;
- research.normalizePages;
- inbox.processInboundMessage.

Schedulers wake retries, post-crawl normalization, inbound-message processing,
reminders, and waiting runs.

## 6. Webhook routes

Convex HTTP routes include:

- /agentmail/webhook for AgentMail signed inbound events;
- the Firecrawl component webhook route configured by its component mount.

Handlers verify signatures, deduplicate event IDs, persist the provider event,
and schedule application work. A webhook never sends a message or publishes
content directly.

## 7. OpenAI boundary

Each model call has:

- a named task;
- a strict input schema;
- a strict output schema;
- a bounded context budget;
- a refusal and incomplete-result path;
- a model/version configuration;
- a safe summary for Activity.

OpenAI may propose an application tool call, but only Convex functions can
execute it. The model receives source content as untrusted evidence and is
never given provider secrets.

## 8. Firecrawl boundary

One-shot calls use search, scrape, or map. Longer work uses startCrawl so
progress and pages live in Convex and the UI can subscribe to them. The
completion callback schedules normalization and indexing exactly once. Local
development may use polling when public webhook delivery is unavailable.

Page-size limits, truncation, stale cache, rate limits, and credit exhaustion
are explicit states, not silent empty results.

## 9. AgentMail boundary

The AgentMail component owns full message bodies, inbound messages, outbound
status, thread relationships, labels, and event ingestion. Application tables
store only the links and summaries needed to connect a thread to a mission or
outcome.

Sending is initiated from a Convex mutation only after an approval record is
validated. Delivery status is queried reactively. Inbound processing receives
the message and current thread context, then schedules OpenAI classification.

## 10. Security and privacy

- Every public function validates its arguments.
- Every query and mutation scopes data to the current identity or demo workspace.
- Provider keys are stored only in Convex deployment environment variables.
- Public-source content and inbound email are untrusted input.
- Approval hashes include recipient, body, subject, capability, and context snapshot.
- Deletion removes sources from retrieval and schedules derived-data cleanup.
- Activity stores redacted summaries rather than full private payloads.
- The app does not expose hidden model reasoning.

## 11. Deployment

The release process is:

1. create a new Convex application;
2. install and configure the Firecrawl and AgentMail components;
3. configure the static hosting component;
4. set deployment environment variables;
5. run local typecheck and tests;
6. deploy the frontend and Convex functions;
7. register the production AgentMail webhook;
8. verify the Firecrawl webhook or polling fallback;
9. open the public convex.site URL in a clean browser;
10. capture evidence for hackathon.md and integration-verification.md.

## 12. Architecture boundary

The active specification uses one Convex backend and the four sponsor
boundaries above. No additional server, database, connector hub, browser
executor, or unrelated provider workflow is required for this hackathon build.
