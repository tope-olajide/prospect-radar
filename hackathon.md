# Hackathon log

- **Project:** Prospect Radar
- **Event:** Convex All Gas Hackathon
- **What it does:** Turns a natural-language opportunity goal into sourced, explained matches, approval-bound AgentMail outreach, live replies, and persisted outcomes on Convex.
- **Live app:** https://wry-walrus-528.convex.site
- **Repo:** https://github.com/tope-olajide/prospect-radar
- **Frontend:** Convex static hosting (@convex-dev/static-hosting)
- **Convex deployment:** wry-walrus-528 (production, team tope-olajide, project prospect-radar)
- **Components:** @firecrawl/firecrawl-convex, @agentmail/convex
- **Convex features:** schema, indexes, queries, mutations, actions, scheduler, HTTP webhooks, reactive subscriptions, function handles
- **Auth:** none (demo workspace scope)
- **AI models:** any OpenAI-compatible model via OPENAI_BASE_URL / OPENAI_MODEL (gpt-5-mini default; provider recorded on plans and classifications)
- **Started:** 2026-09-13T00:00:00Z
- **Last updated:** 2026-09-15T21:05:00Z

## Log

### 2026-09-15 - working tree
Built the autonomous mission orchestrator: a scheduled internal action now
drives each run through interpret → plan → discover → evaluate → approval
using per-mission search queries and crawl targets materialized from the
strategy plan (new missionQueries table), one durable stage per invocation.
The approval gate is a hard stop — nothing sends without a human. Added a
user Stop control, blocked-stage retry with classified error codes and
bounded auto-retries, a live agent transcript (run steps now carry the tool
that produced them: llm.classify, llm.plan, firecrawl.search,
firecrawl.crawl, orchestrator), a pipeline stage strip in the UI, and a
completion predicate check after every send that flips the mission complete
when a sourced match was approved and sent. 16 new orchestrator tests
(64/64 total) cover stage dispatch, the hard gate, stop/no-op semantics,
failure blocking, retry, and the predicate. Deployed to production.

### 2026-09-15 - working tree
Shipped AI intent classification: removed the intent/mode dropdown so users
submit natural language only. A two-stage LLM pipeline now runs before any
planning — `ai.classifyMissionIntent` semantically classifies the request
(primary + secondary intent, target entity, relationship goal, one-line
"Radar understood" summary, clarification question only when ambiguity
materially changes the search), then `ai.planMission` generates the strategy
plan using per-intent strategy guidance (`convex/intentStrategy.ts`: entity
focus, source priorities, evidence requirements, match criteria, recommended
actions) so intent genuinely changes discovery and evaluation instead of
decorating prompts. Confirmed context facts resolve references like "what I
do". The UI shows the AI's understanding with Adjust / Re-classify controls
and a clarification answer path. 22 new tests drive the classifier, planner,
strategy data, prompt-injection guard, and schema-invalid replies through
real Convex functions with a mocked LLM (48/48 total).

### 2026-09-15 - working tree
Proved the production webhook flow end-to-end with a signed probe
(`scripts/signedWebhookProbe.mjs`): a correctly svix-signed event returned
200 accepted and was ingested by both the component and app stores, an
identical replay returned duplicate_ignored (idempotent by event_id), and a
tampered signature was rejected with 401. Hardened the handler to accept both
svix-* and webhook-* header prefixes and to normalize `from_`/`from` message
naming before component ingest.

### 2026-09-15 - cea64ca
Deployed the app to production: pushed the Convex backend with all four
components (firecrawl, agentmail, staticHosting) to the prod deployment, built
the frontend against the prod URL, and published static files via the official
Convex Static Hosting component. Live at https://wry-walrus-528.convex.site —
verified the served bundle points at the prod backend with no localhost
references; production env keys set for Firecrawl, AgentMail, and the
OpenAI-compatible LLM endpoint.

### 2026-09-13 - 5717024
Defined the Convex-first product plan across eleven docs: mission lifecycle,
sponsor boundaries, verification matrix, and the approval trust model
(`docs/`, `handoff.md`).

### 2026-09-13 - 2ee65ac
Bootstrapped the React/Vite frontend and Convex backend with the generated
API surface (`src/`, `convex/`, `index.html`).

### 2026-09-15 - 61c2530
Added the reactive mission lifecycle: transactional mission creation that also
creates the durable run and its first run event, plus mission listing and
selection in the UI (`convex/missions.ts`, `convex/runs.ts`, `convex/schema.ts`).

### 2026-09-15 - 72f2f4f
Added the research and outreach core: mission plans from an OpenAI-compatible
endpoint with strict JSON validation, Firecrawl search/scrape with provenance
and deduplication, approval-bound drafts (SHA-256 content hash, one-hour
expiry, server-side enforcement), idempotent AgentMail sends, a signed Svix
webhook persisting inbound replies and delivery events, scheduled reply
classification with suggested approval-bound follow-ups, and outcome records
(`convex/research.ts`, `convex/outreach.ts`, `convex/inbox.ts`, `convex/http.ts`,
`convex/outcomes.ts`, `src/App.tsx`).

### 2026-09-15 - f9b3dd9
Migrated Firecrawl and AgentMail to their official Convex components
(`@firecrawl/firecrawl-convex`, `@agentmail/convex`): component-backed
search/scrape plus site mapping and durable crawls with completion callbacks,
component-owned durable sends with reactive outbound status, component-side
webhook ingest alongside app-owned event records, and a vitest suite for
approval hashing, content bounding, and payload guards
(`convex/convex.config.ts`, `convex/research.ts`, `convex/outreach.ts`,
`convex/http.ts`, `tests/unit.test.ts`).

### 2026-09-15 - ddc29c9
Added AI match explanations: stored evidence is sent as bounded untrusted
context to the configured model, which returns per-match labels, grounded
positive evidence, unknowns, risks, and recommended actions; provider and
model provenance persist per match (`convex/ai.ts`, `convex/researchStore.ts`).

### 2026-09-15 - a9007a7
Rebuilt the frontend as a multi-view app shell: sidebar navigation with live
counts, topbar status, mobile drawer, and six views (radar brief, discover,
outreach, inbox, outcomes, activity) with attention cards, quick prompts, and
full approval cards showing context and side effects (`src/App.tsx`,
`src/index.css`).

### 2026-09-15 - 2e2f7a2
Closed the Phase 2 trust and profile work: approval-bypass, tampering, expiry,
idempotency-conflict, webhook-replay, cross-workspace, label-scope, and
context-verification tests (20 passing) via convex-test; context facts with
confirm/correct/reject/delete and a new Context screen; inbox label toggles;
send-time hash recheck so approvals are bound to exact bytes; wake-on-reply
run transitions; and confirmed profile facts now guide match explanations and
drafting (`convex/context.ts`, `convex/inbox.ts`, `convex/outreach.ts`,
`convex/outreachStore.ts`, `convex/researchStore.ts`, `convex/ai.ts`,
`tests/trust.test.ts`, `src/App.tsx`).

### 2026-09-15 - working tree
Phase 3 deployment wiring: installed the official Convex Static Hosting
component (`@convex-dev/static-hosting`), registered it in
`convex/convex.config.ts`, mounted `registerStaticRoutes` after the exact app
webhook routes in `convex/http.ts` (so `/agentmail/webhook` and `/firecrawl/*`
keep priority), and added the `npm run deploy` script. Frontend target:
`https://<deployment>.convex.site`. Cloud deployment pending `npx convex login`
(user authentication step) plus production env keys.

### 2026-09-15 - working tree
Finished Phase 1: `ai.draftMessage` drafts outreach grounded in one match's
stored evidence and accepts a recipient only when the address literally
appears in that evidence, otherwise returning the draft for manual review;
added a reactive durable-crawl progress line sourced from the Firecrawl
component's crawl state; installed the official Convex agent skills and the
hackathon build-log skill (`.agents/skills/`, `AGENTS.md`)
(`convex/ai.ts`, `convex/researchStore.ts`, `src/App.tsx`).
