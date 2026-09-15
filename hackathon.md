# Hackathon log

- **Project:** Prospect Radar
- **Event:** Convex All Gas Hackathon
- **What it does:** Turns a natural-language opportunity goal into sourced, explained matches, approval-bound AgentMail outreach, live replies, and persisted outcomes on Convex.
- **Live app:** not deployed
- **Repo:** https://github.com/tope-olajide/prospect-radar
- **Frontend:** not deployed (React/Vite; Convex static hosting planned)
- **Convex deployment:** not deployed (local dev deployment in use)
- **Components:** @firecrawl/firecrawl-convex, @agentmail/convex
- **Convex features:** schema, indexes, queries, mutations, actions, scheduler, HTTP webhooks, reactive subscriptions, function handles
- **Auth:** none (demo workspace scope)
- **AI models:** any OpenAI-compatible model via OPENAI_BASE_URL / OPENAI_MODEL (gpt-5-mini default; provider recorded on plans and classifications)
- **Started:** 2026-09-13T00:00:00Z
- **Last updated:** 2026-09-15T15:25:00Z

## Log

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

### 2026-09-15 - working tree
Finished Phase 1: `ai.draftMessage` drafts outreach grounded in one match's
stored evidence and accepts a recipient only when the address literally
appears in that evidence, otherwise returning the draft for manual review;
added a reactive durable-crawl progress line sourced from the Firecrawl
component's crawl state; installed the official Convex agent skills and the
hackathon build-log skill (`.agents/skills/`, `AGENTS.md`)
(`convex/ai.ts`, `convex/researchStore.ts`, `src/App.tsx`).
