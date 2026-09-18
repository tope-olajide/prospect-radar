# Hackathon log

- **Project:** Prospect Radar
- **Event:** Convex All Gas Hackathon
- **What it does:** Turns a natural-language opportunity goal into sourced, explained matches, approval-bound AgentMail outreach, live replies, and persisted outcomes on Convex.
- **Live app:** https://wry-walrus-528.convex.site
- **Repo:** https://github.com/tope-olajide/prospect-radar
- **Demo video (< 3 min):** _link pending — will be added before the Sept 22 submission_
- **Submission:** due Sept 22, 12:00 PM PT at vibeapps.dev; social post tagging @convex @OpenAI @firecrawl @agentmail
- **Frontend:** Convex static hosting (@convex-dev/static-hosting)
- **Convex deployment:** wry-walrus-528 (production, team tope-olajide, project prospect-radar)
- **Components:** @firecrawl/firecrawl-convex, @agentmail/convex (vendored as a local component under `convex/agentmail/` — the published build declares its app-facing functions `internal*`, which are invisible to the parent; see `convex/agentmail/README.md`), @convex-dev/static-hosting, @convex-dev/workpool
- **Convex features:** schema, indexes, queries, mutations, actions, scheduler, HTTP webhooks, reactive subscriptions, function handles
- **Auth:** none (demo workspace scope)
- **AI models:** any OpenAI-compatible model via OPENAI_BASE_URL / OPENAI_MODEL (DashScope qwen-max in production; provider recorded on plans and classifications)
- **Started:** 2026-09-13T00:00:00Z
- **Last updated:** 2026-09-18T14:45:00Z

## Log

### 2026-09-18 - agent UX upgrade: plan review, check-in, inline tool cards, source chips, follow-up suggestions, parallel jobs
Six UX gaps identified by comparing Radar against ChatGPT Agent, Devin, Manus, Perplexity, and Cursor. All six implemented end-to-end, frontend and backend.

**Gap 1 — Plan preview.** After intent classification and planning, the run pauses at a new `plan_review` stage (`waiting` status). The Home screen renders a plan card showing the normalized goal, must-haves, nice-to-haves, exclusions, sources, and strategy. The user clicks Approve Plan to resume. Mutations: `approvePlan` in `convex/orchestratorStore.ts`. Stage added to `runState.ts` transitions, `runs.ts` validators, `schema.ts` runStage union, and `MissionLifecycle.tsx` lifecycle rail.

**Gap 2 — Inline tool cards.** The flat transcript list is replaced with expandable step cards in the active mission area. Each card shows a stage-colored dot, label, tool chip, and summary; clicking expands to the full receipt. CSS in `src/index.css` (`.step-cards`, `.step-card`, `.step-card-head`).

**Gap 3 — Follow-up suggestions.** After mission completion with matches, a "What next?" row renders contextual pills: "Draft outreach to top match", "Review all entities", "See pipeline", "Find similar". Each navigates to the appropriate view.

**Gap 4 — Source chips.** Match cards now show an inline source chip with the hostname of the crawled source, linking back to the evidence. CSS: `.source-chip`.

**Gap 5 — Mid-run check-in.** New `check_in` stage between `discover` and `evaluate`. After discovery finishes, the run pauses in `waiting` at `check_in`. Home renders a check-in card showing source count, entity count, signal count, and match count. The user clicks Continue to evaluation. Mutations: `continueAfterCheckIn` in `convex/orchestratorStore.ts`. Added to `runState.ts`, `runs.ts`, `schema.ts`, `MissionLifecycle.tsx`.

**Gap 6 — Parallel task visibility.** During the `discover` stage, a compact research bar shows live Firecrawl job pills with running/complete/failed status and result counts. CSS: `.parallel-jobs`, `.job-pills`, `.job-pill`.

All changes backed by real Convex state: `plan_review` and `check_in` are durable run stages with persisted transitions. 187 tests pass. Deployed to `wry-walrus-528.convex.site`.

### 2026-09-17 - later ×6 — Home rebuilt as the agent conversation; Dashboard split out
**Home** is now a single-column AI workspace, ChatGPT-style: every mission renders
as a **conversation thread** — your goal as the user message, Radar's response
beneath with its recorded understanding, the truthful lifecycle rail, the full
step receipt trail (collapsible), progressive strong-match cards while the run
works, and an approval card when Radar is waiting on you. The **composer stays
at the bottom, always accessible** — new goals submit from the same surface. No
scrolling away to discover that Radar started; the newest thread appears above
the input. All state is real Convex subscriptions (new bounded
`commandCenter:missionLiveThreads` query feeding the threads).
The marketing panels (**THE JOURNEY** steps, sponsor capability chips) and the
overview/attention metrics moved off Home into a separate **Dashboard** view —
Home stays focused on ask → watch → decide. Verified: tsc clean, build passing,
deployed to `wry-walrus-528.convex.site`.

### 2026-09-17 - later ×5 — Outcomes & Context redesigned; agent-first pass complete
**Outcomes** now opens with a workspace-wide stage summary, surfaces ongoing
sequences with their next-step state, attributes every follow-up to whoever
scheduled it (Radar or you), and shows each relationship card with Radar's
next step (and when) above an **always-visible relationship memory timeline**
— newest events first, no longer hidden behind a collapsed details toggle.
**Context** groups facts by verification state and says what Radar actually
does with each group: confirmed facts "are already steering plans, matches,
and drafts"; unreviewed ones "stay unused until you confirm"; rejected ones
are excluded from every prompt. Provenance is written in plain language
("added by you", "inferred by Radar") instead of enum names.

Every primary surface now follows the same agent-first language: lifecycle
(Home/Activity), reasoning (Discover), supervision (Outreach/Forms/Inbox),
memory (Outcomes), and the user's own ledger (Context, Data sources).

### 2026-09-17 - later ×4 — Discover & Inbox redesigns shipped; full agent loop re-proven live on the redesigned UI
**Discover** match cards now carry a **why-chain**: why Radar looked (the plan
query that surfaced the source, joined from the research job), why it matches,
up to three cited evidence quotes, unknowns, risks, and which of the user's
data sources the judgment was checked against. **Inbox** threads show their
mission, Radar's latest read, and pending drafts; the conversation renders
"Radar understood → proposed next action → drafted reply" with the exact
approval state (including expiry) for every classification.

Then the canonical proof mission was re-run live against the deployed site so
every captured state is the redesigned UI's data: qwen-max classified
`find_opportunity` (target organization, goal `become_their_vendor`), Firecrawl
ran 10 jobs across search/crawl/extract (22 sources), 6 entities + 4 signals,
22 matches with 6 explained, draft → hash-bound approval → **AgentMail send**
(real SES delivery id) → **counterpart replied inside the provider thread** →
**signed webhook delivered it** → classified `needs_info` with a suggested
next action → follow-up reply drafted → approved → **sent** → delivery state
confirmed. Outcome, 1 sequence, 2 follow-ups persisted; idempotent re-send
returned the same message. Evidence in `proof/agent-loop.json`.

### 2026-09-17 - later still — mission & run screens rebuilt around the agent lifecycle
The redesign's second piece: the agent is now the primary character on the
three screens where you supervise it.

**MissionLifecycle (`src/MissionLifecycle.tsx`).** One truthful lifecycle —
understand → plan → research → evaluate → approval → act → complete — whose
every node derives from `(run.status, run.currentStage)`: done only if the run
has verifiably moved past it, active only if the run is in it right now. The
active node shows the agent's **latest recorded step** (label, summary, tool)
— real `runSteps` receipts, no optimistic updates, no fake progress, no
animation. Waiting, budget-blocked, stale-parked, and failed states each have
their own honest note and color.

**Home:** the mission queue became an **agent runs board**
(`commandCenter:runsBoard`): per mission — run status, current stage, the
agent's last step, and how many approvals are waiting, all live via reactive
subscription. **Mission panel:** the lifecycle rail replaced the one-line
stage readout. **Activity:** the same lifecycle replaced the terse stage pills,
with the step transcript and event trail beneath it. The dev-only stage strip
and `STAGES` constant are gone.

187 tests pass (the lone failure in one full-suite run was the known flaky
timing assertion under load; it passes consistently in isolation and on the
re-run), tsc clean, deployed.

### 2026-09-17 - later — Data sources + dual-theme redesign (UI phase begins)
The agent-experience redesign starts: a light/dark theme system, and the new
**Data sources** page — the user's side of the evidence ledger.

**Data sources (frontend + backend).** Users upload what Radar cannot find on
the public web: a freelancer's portfolio, a company's product one-pager, a
résumé. Three kinds — **file** (drag-and-drop, 20 MB cap, stored via Convex
file storage, text extracted and chunked), **website** (single page, crawl, or
sitemap ingested through the Firecrawl component's durable crawl with a
completion callback, plus manual resync), and **snippet** (paste up to 20k
chars). Everything is chunked (~1.2k chars, overlapping) into
`dataSourceChunks` with a Convex **search index**, so the agent retrieves only
the mission-relevant chunks — never a whole document. Retrieval is wired into
the real pipeline: intent classification, match explanations, outreach drafts,
and sequence steps all now receive `userSources` alongside confirmed facts,
with the same grounding rule (sources describe the sender only; they are never
cited as evidence about a match). Tests: 13 new (chunking, CRUD, relevance
ordering, ingest success/failure/late-callback paths).

**Dual theme.** Full token rewrite of `index.css` — light base, dark via
`[data-theme="dark"]`, defaults to the **operating system preference**
(pre-paint script in `index.html` prevents any flash), with a System / Light /
Dark switch in the sidebar persisted to localStorage and live-following the OS
while in System mode.

Deployed to https://wry-walrus-528.convex.site (functions + static frontend).

### 2026-09-17
Crawl-failure recovery, the crawl watchdog, and the full live agent-loop proof.

**Three resilience bugs found by running the live outreach proof, fixed.**
(1) A durable crawl that Firecrawl refuses (robots.txt) or that ends without
completing used to fail the whole mission — even with 19 sources already
stored — because the crawl callback marked the run `failed` unconditionally.
`completeCrawl` now continues the run to `evaluate` with the evidence it has
(records `crawl.failed` with the provider reason) and fails the mission only
when it has neither sources nor pending discovery. (2) A provider call the
orchestrator makes (search, crawl start) that throws used to strand the run;
the discover stage now consumes that query via `orchestratorStore.failQuery`
with the classified reason and keeps working down the backlog. (3) Automatic
retries scheduled `runStage` directly — but `blocked` is deliberately not
advanceable, so the retry silently did nothing. A new
`orchestratorStore.retryResume` re-opens the block (only while the run is
still blocked on the same interruption, so it can never steal a user-stopped
or budget-blocked run) and then schedules the stage.

**Crawl watchdog (`convex/crawlWatchdog.ts`, cron every 10 minutes).** The
other half of the same class: a run parked `waiting` on a crawl whose callback
never arrives stayed waiting forever. The sweep distinguishes the two `wait`
producers by the run's latest event — it resumes runs waiting on
`crawl.awaiting` (with stored sources it advances to `evaluate`; with none it
parks as `blocked`/`crawl_timed_out`) and never touches runs waiting on a
counterpart's reply (`action.sent`), which only the counterpart can end.

**Live proof re-run end to end after the fixes (`proof/agent-loop.json`,
26/26 material steps):** natural-language mission → qwen-max classified
`find_opportunity`, target organization, goal `become_their_vendor`, with the
rationale recorded → 4 real Firecrawl searches, 19 deduplicated sources → 6
entities + 3 signals extracted → 19/19 matches explained by qwen-max with
evidence-grounded summaries, unknowns, and recommended actions (`
contact_via_platform`, `research_alt_route`) → draft → approval bound to the
exact content hash → AgentMail send → delivery confirmed (SES message id) →
counterpart reply inside the real thread → signed inbound webhook → reply
classified `needs_info` with a suggested reply → approval → continuation send
delivered → outcome persisted at `contacted` with sequences and follow-ups →
idempotent re-send proven. First attempt surfaced the three bugs above plus a
second real one (explanations not landing during the orchestrator's evaluate
hop): `ai.explainMatches` re-run live explained all 19 matches, and the
orchestrator failure path now records a step receipt instead of dying
silently.

**Tests:** 174 across 14 files — new `tests/crawlRecovery.test.ts` (crawl
failure continues the mission with evidence; fails honestly with none;
`failJob` never kills a working run; retry re-opens its own block and never
steals another owner's run) and `tests/crawlWatchdog.test.ts` (resume with
sources; reply-waits untouched; empty crawl parks visible; freshness and
single-fire). tsc clean; backend deployed.

### 2026-09-16 - working tree
Stale-run reaper, and the failure-path proofs (Phase 7, item 2).

**The reaper (`convex/runReaper.ts`, cron every 10 minutes).** A run only
advances because a stage schedules its successor or is waiting on an external
callback. A stage that dies without transitioning — a provider call made outside
the orchestrator's try/catch, a scheduled continuation that never fired — left
the row `active` forever, so the command center kept reporting abandoned work as
in progress. Production showed exactly that: five runs stuck `active` at
`evaluate`. The reaper parks an `active` run whose `updatedAt` has not moved in
30 minutes as `blocked` with `activeInterruption: "stale_run"`, keeping its stage
so the ordinary retry control resumes it. It never touches runs that are
deliberately parked (`waiting` on a crawl, `blocked` on a classified failure,
terminal) or simply not started (`queued`). **Live proof:** the scheduled sweep
fired on its own and parked all five in one pass (identical `updatedAt`, no
client connected).

The same audit fixed a smaller lie: the overview counted `queued` runs as
"working". It now reports **Working now** (a stage is executing), **Ready to run**
(created, waiting for the user), and **Parked** — so the Home screen's numbers
mean what they say.

**Failure-path proofs (`scripts/failurePathsProof.mjs`, 13/13).** Evidence in
`proof/failure-paths.json` and docs/integration-verification.md §8.2. The harness
labels each entry **REAL** (probed live during the run) or **TEST-VERIFIED**
(cannot be forced through the public API, so proven by a *named* test it executes
and records):

- **REAL:** unsigned webhook → 401; forged `svix-signature` → 401; and a live
  login wall — `https://github.com/login` scouted as `blockedReason:
  login_required` with 3 fields refused and no proposal created.
- **TEST-VERIFIED:** replayed webhook event, expired approval, tampered draft
  after approval, approval bypass, cross-workspace send, tampered form payload,
  login wall at scout time, human check, auth wall at execution, and form
  submission without approval.

The consistent property across all thirteen: the dangerous path fails **closed**
and records *why* — never a fabricated success.

4 new reaper tests plus the failure-path harness; **158 tests** across 12 files.

### 2026-09-16 - working tree
Phase 6: hardening and operations. "Run Radar end-to-end" spends real Firecrawl
credits, so the cost is now estimated before it starts and enforced while it
runs.

- **Provider credit budget** (`convex/budget.ts`): one cap per workspace
  (`workspaceBudgets`) plus an append-only ledger (`creditCharges`). A documented
  cost model estimates search (per result), crawl (per page), scrape, and
  structured extraction; the mission console shows used / cap / remaining, the
  pending-work estimate, and the spend split by operation *before* the run
  button. Every provider call charges the ledger with a reference derived from
  the *logical work* (the query, the source, the crawl), so a retried attempt
  never double-charges.
- **Running out of credits is a budget block, not an error.** The orchestrator
  pre-flights each provider call; if the estimate no longer fits, the run parks
  in `blocked` with `activeInterruption: "budget_blocked"`, keeps its stage, and
  records a `budget.blocked` receipt (tool `budget`, code
  `FIRECRAWL_CREDITS_EXHAUSTED`) that states the numbers and what to do. Raising
  the cap and using the ordinary retry control resumes exactly where it stopped —
  no special path.
- **Retry policy centralized** (`convex/retryPolicy.ts`): the retry budget, the
  retryability decision, and the backoff now live in one module, so a new
  provider failure is classified once and every stage inherits the behaviour.
  Backoff is exponential with a per-code base (rate limits cool off longer) and a
  hard ceiling; non-retryable codes (exhausted credits, policy refusals, invalid
  webhooks) never loop.
- **Idempotency sweep**: the four external writes are idempotent by provider
  reference — crawl page ingest (job-complete short-circuit plus per-URL
  replace), AgentMail send (content hash + client request id), form submission
  (single transactional claim per approval), and inbound webhook (event id).
  Crawl ingest was the one without a test; it now has one, including a partial
  re-delivery.
- **Untrusted-content bounding re-audited** across the new LLM and provider
  paths: provider text never reaches a user-facing message, and hostile page
  content is clamped before it becomes evidence.
- **Load sanity**: a 20-query mission drains with exactly one provider call per
  query and no fan-out; stale invocations on a non-advanceable run make no
  provider call and schedule nothing.

`tests/hardening.test.ts` adds 16 tests (**154 total**) covering the cost model,
cap bounds, ledger idempotency, the budget-block lifecycle and its resume, the
retry taxonomy and backoff, crawl-ingest idempotency, output bounding, and the
20-query drain.

### 2026-09-16 - working tree
Phase 5: the Radar command center. Home is now a real product surface rather
than a form: a search-first command bar, a live network overview, and an
editable mission brief.

- **Command bar search** (`convex/commandCenter.ts`) searches entities,
  relationships, and messages through three Convex search indexes. Convex
  search indexes cover one field per index, so `searchText` is denormalized at
  write time (`convex/hash.ts` `searchableText`, written on entity upsert,
  outcome transition, and inbound message) and filtered by `workspaceId` at
  read time. A bounded, idempotent `backfillSearch` internal mutation fills
  legacy rows; it was run against production (6 runs adopted a `workspaceId`).
- **Network overview** aggregates missions, runs by state, entities, signals
  this week, threads, replies, follow-ups due, pending/approved drafts, and
  submissions — each through a `by_workspaceId` index with a bounded `take`, so
  the Home screen costs a fixed number of queries and never joins per row.
- **Editable mission brief** (`plans.updateBrief`) lets the user correct the
  goal, must-have/nice-to-have criteria, exclusions, preferred sources, and the
  completion predicate. The predicate is mirrored onto the mission, because
  that predicate is exactly what gates the run's own completion claim; every
  edit records a `brief.edited` run step with `tool: user`.
- **Accessibility**: a skip link, a labelled search landmark, labelled metrics,
  and non-color-only status text.

A new `tests/queryContracts.test.ts` calls **every public query the app
actually calls** against a fully populated workspace. It immediately caught two
more instances of the raw-document/view-validator bug that the form proof run
found in `runs.*`: `inbox.listMessages` leaked `agentmailInboxId`, `workspaceId`,
`missionId`, and `searchText`, and `researchStore.listJobs` leaked `errorCode`
because its view never declared it. Both are now mapped explicitly, so this class of
production-only `ReturnsValidationError` is closed by contract tests rather than
discovered by users (138 tests passing).

### 2026-09-16 - working tree
Live end-to-end form-flow proof run against the production deployment
(`scripts/formFlowProof.mjs`, evidence in `proof/form-flow.json` and
`proof/form-flow-screenshot.png`, target `https://httpbin.org/forms/post` - a
public form built to echo a POST, so nothing unsolicited was sent to a real
business). The run discovered the form through Firecrawl search, scouted 7
fields, filled 6 from confirmed facts with the live OpenAI-compatible model
(`dashscope:qwen-max`), bound an approval to the payload hash, executed the
Firecrawl `actions` submission, stored a 1920x1080 screenshot, and proved
idempotency (a second execution returned `already_submitted` with no second
Firecrawl call and one submission row). The target's own echo of the request
body is the proof: `custname`, `custtel`, `custemail`, `size: "medium"`,
`topping: ["bacon","cheese"]`, `comments` - with `delivery` left empty because
no confirmed fact covered it.

The run earned its keep by finding three real defects, all fixed:
(1) form scouting read markdown, where input `name` attributes do not exist, so
the model invented names (`customer_name` for a real `name="custname"`) and
produced selectors that failed with "Element not found" - scouting now parses
the returned DOM deterministically and keeps the model extraction only as a
fallback; (2) the extractor inferred `required` from labels, which wrongly
blocked approval on a form that marks nothing required - `required` now comes
from the actual HTML attribute; (3) `runs.forMission`, `runs.events`, and
`runs.steps` returned raw documents against narrower view validators and so
raised `ReturnsValidationError` on every production call, meaning the Activity
run panel had been silently showing "no run" - the views now map their fields
explicitly and `tests/runs.test.ts` locks the contract (128 tests passing).
Also added: radio/checkbox-group filling by attribute
(`input[name="size"][value="medium"]`), a scouted submit selector so bare
`<button>` controls work, and a submission cap that only counts real
submissions rather than blocked attempts.

### 2026-09-16 - working tree
Phase 4: form intelligence and approval-bound submissions. Radar can now take
a public application or contact form from discovery to a screenshot-evidenced
submission. `formFlows.scoutForm` reads a page with Firecrawl's structured
json extraction over the full document (fields, labels, types, required flags,
options, CSS selectors) and persists a `formTemplates` row, including detected
boundaries: a login wall becomes `login_required`, a CAPTCHA or bot check
becomes `human_check_required`, and neither is ever attempted.
`formFlows.proposeFill` maps only **confirmed** context facts onto the fields
by numbered fact index, so an ungrounded value is dropped rather than trusted,
file inputs are never filled, and unmatched required fields block approval.
Approval reuses the shared approvals primitive with the `submit_form`
capability, bound to a SHA-256 of the exact target URL plus ordered field
values under a `payloadHash`; revising a payload revokes its approval.
`formFlows.executeFormSubmission` runs one approved payload through Firecrawl
`actions` (wait/click/write/press, submit, settle, full-page screenshot,
post-submit scrape), stores the screenshot in Convex file storage as
`evidenceFileId`, and records an immutable `formSubmissions` row. Execution is
idempotent per proposal (one approval = one submission, proven by a test that
counts Firecrawl calls), a transactional gate enforces a per-workspace daily
submission cap, a detected human check or auth wall is recorded as
`blocked_human_check` / `blocked_login` rather than a fake success, and every
step lands in the agent transcript (`firecrawl.scout`, `firecrawl.form`,
`llm.form_fill`, `approval`). New Forms view: scout a source, review the
field list, propose a fill, correct each value from confirmed facts, approve
and submit, then read the submission history with its screenshot.
(`convex/formFlows.ts`, `convex/formStore.ts`, `convex/schema.ts`,
`src/App.tsx`, `src/index.css`, `tests/forms.test.ts` - 21 new tests, 114
total passing; deployed to production, live bundle verified)

### 2026-09-15 - working tree
Shipped the relationship pipeline: outcomes now carry a stage (contacted,
replied, engaged, meeting, proposal, won, lost, dormant), so a relationship
is a tracked object rather than a single send. Reply classification feeds a
strict-schema next-step planner (`ai.suggestNextStep`) that advances the
stage, schedules a follow-up for a deferral, and queues a suggested reply
draft that still needs approval. New followUps, meetings, and
outreachSequences tables: the first confirmed send for a match opens a 2-3
step sequence whose later steps are drafted only when their trigger fires
(never sent), with each step requiring its own approval - a test proves
approving step 1 does not approve step 2. A scheduled cron sweep
(`convex/crons.ts`) marks overdue follow-ups and wakes the sequence engine;
snooze, complete, and meeting recording are user mutations. Inbound mail on
a thread Radar opened now inherits its mission and match instead of
orphaning the reply. UI adds a Pipeline view (stage columns, per-relationship
timeline, next-step chips with due states, snooze/complete controls, meeting
recorder) plus a sequence stepper in Outreach; the attention rail now
includes due follow-ups and queued steps. 12 new tests (93/93 total);
deployed to production with the live bundle re-verified.

### 2026-09-15 - working tree
Shipped the entity and signal engine: discovery output now resolves into
entities (person / organization / product) with extracted attributes,
expressed needs, offers, signals, and a provenance-checked contact route
(new entities + entitySignals tables with canonical-URL, normalized-name,
and evidence-URL dedupe). Resolution uses Firecrawl JSON mode (json format
with a strict schema over cached scrapes); when the provider fails or
returns an untrustworthy shape, Radar keeps a snippet-only entity instead of
a guess and records the classified error. Contact routes survive only with a
real public source URL, and email values are validated. The orchestrator now
resolves entities before explaining, and match explanations cite extracted
attributes and signals — with an explicit rule that a match with no known
route gets "research_alt_route" rather than outreach. UI adds an Entities &
Signals panel (kind badges, needs/offers, sourced contact, signal chips) and
enriched match cards. 17 new tests (81/81 total). Deployed to production.

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
