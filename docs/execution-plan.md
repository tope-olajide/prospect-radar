# Prospect Radar — full-capability execution plan

Regenerated after the capability audit and competitive design research
(Claygent, AI SDR agents such as 11x/Artisan, and 2026 agent-UX patterns).
No phase carries a time estimate: order follows dependency and impact only.
Nothing from the previous "out of scope" list is deferred — every capability
below is planned, with safety boundaries enforced in code.

## Design DNA adopted from category leaders

1. **Claygent (Clay):** an agent = goal + browser + tools + defined output
   shape. Its differentiator is per-entity custom data-point extraction with
   citations, not link lists. → Radar adopts **entity-centric research**:
   every discovery resolves to an entity (person / organization / product)
   with extracted attributes and provenance.
2. **AI SDR agents (11x, Artisan):** the product is a *pipeline of
   relationships*, not a search page. Signals trigger work; sequences handle
   follow-ups; replies resume the workflow; outcomes land in a pipeline view.
   → Radar adopts **signals, sequences, and a relationship pipeline**.
3. **Agent-UX consensus:** Plan → Approve → Execute; a "receipts" UI that
   shows the agent's work live; provenance on every claim; honest uncertainty;
   a stop control everywhere. → Radar's run transcript, understanding card,
   and approval gates already follow this; they become first-class.

## Sponsor usage to the fullest (target matrix)

| Sponsor | Features exercised |
| --- | --- |
| Convex | schema + indexes; queries/mutations/actions; internal function graph; scheduler (stage advance, wake-ups, follow-ups, retries); reactive subscriptions on every screen; HTTP webhooks (AgentMail, Firecrawl); Firecrawl + AgentMail + static-hosting components; file storage for screenshot evidence; search index for entity lookup |
| Firecrawl | search (with freshness `tbs`, categories, highlights); scrape (markdown + screenshot); structured extraction (`formats: [{ type: "json", schema }]`); map; durable crawl with reactive progress and completion callbacks; browser `actions` (click/type/wait/press) for approved form flows |
| OpenAI-compatible LLM | intent classification; strategy planning; form-field mapping; entity extraction validation; match explanation with citations; outreach drafting; reply classification; next-step suggestion; sequence step drafting |
| AgentMail | agent-owned inboxes; durable sends; delivery status events; inbound webhooks; threads + labels; reply-driven continuation; approval-bound follow-up sends |

## Phase 0 — Foundation (done)

Deployed production app with: AI intent classification (no dropdown),
strategy-bearing plans, Firecrawl search/scrape/map/crawl with error classes
and freshness labels, AI match explanation with confirmed-fact profile,
approval-bound AgentMail outreach with content-hash binding, webhook
verification + idempotency, context-fact workspace, inbox labels, run-step
records, wake-on-reply, Convex static hosting, 48 automated tests. Trust
tests prove: cross-workspace rejection, approval-required, stale-hash
rejection, expiry, idempotent replay, dedupe, label/fact gating.

## Phase 1 — Autonomous mission run + live agent transcript

The run drives itself through stages; the user watches it work and stops it
anytime. This is the "one prompt → shortlist" demo moment.

### Backend
1. `convex/missionOrchestrator.ts`: `internalAction runStage({ missionId })`
   dispatching on `run.currentStage`:
   - `interpret` → classify (if missing) → plan → schedule `discover`;
   - `discover` → run pending mission queries (search per plan
     `recommendedSources`; crawl for `crawlTargets`) → `evaluate`;
   - `evaluate` → build matches, run extraction (Phase 2), `explainMatches`
     → `approval`;
   - `approval` → transition `wait` ("awaiting user approval") — hard stop,
     never auto-advances past a human gate;
   - every stage completion schedules the next via
     `ctx.scheduler.runAfter`; failures → `blocked` with classified error
     code + `retryStage` mutation (bounded retries with backoff).
2. `ai.planMission` additionally emits `searchQueries: string[]` (3–6,
   derived from intent strategy `sourcePriorities`) and `crawlTargets`:
   string[]; persisted in a new `missionQueries` table
   `{ missionId, query, kind: search|crawl, status, resultCount }`.
3. `missions.checkCompletion`: evaluates the plan completion predicate
   (e.g. "approved action exists for ≥1 sourced match") and transitions the
   mission `complete` with a run event.
4. `runs.stop` mutation: user-visible stop button transitions the run to
   `cancelled` at any stage; scheduled stages check status before executing.
5. Run transcript: extend `runSteps` writes with a `tool` field
   (`firecrawl.search`, `firecrawl.extract`, `llm.explain`, `agentmail.send`,
   …) so the UI can render a real agent trace, not just status text.

### Frontend
1. Run panel: **Run Radar end-to-end** primary action; live stage strip
   (intake → interpret → plan → discover → evaluate → approval) driven by the
   existing run subscription; Stop button; blocked-state retry affordance.
2. **Agent transcript view** (Activity upgrades): chronological receipts —
   each step shows tool, human-readable summary, reference link (source URL,
   plan, draft, message), error code when present. Live-updates reactively.
3. Understanding card stays the first receipt ("Radar understood…").

### Tests
Orchestrator advances through all stages with mocked LLM/Firecrawl; hard
stop at approval; blocked-on-failure + bounded retry; stop cancels pending
stage; completion predicate flips mission to complete; transcript rows carry
tool names.

### Complete when
A fresh mission advances from prompt to approval-gate with zero manual stage
buttons, every step visible live, and any failure leaves an honest blocked
state with a retry.

## Phase 2 — Entity & signal engine (the network model)

Reshape discovery output from "URL rows" to **entities with attributes and
signals** — the Claygent lesson, and the audit's §23 network model made
real. Two-sided by construction: an entity can be a provider (person/agency)
or a demand holder (company with a need).

### Backend
1. New tables:
   - `entities`: `{ workspaceId, missionId, kind: person|organization|product, name, canonicalUrl, attributes (json), summary, contactRoute: { kind: email|form|linkedin|none, value, publicSource } | null, firstSeenAt, updatedAt }` with `by_workspaceId`, `by_missionId`, search index on `name`;
   - `entitySignals`: `{ workspaceId, entityId, missionId, type: hiring|project_request|rfp|complaint|funding|launch|expansion|other, statement, evidenceUrl, observedAt, confidence }` with `by_entityId`, `by_missionId`.
2. `convex/entityStore.ts`: `upsertEntity` (dedupe by canonicalUrl + name
   similarity via search index), `recordSignal` (dedupe by evidenceUrl+type).
3. Structured extraction in `research.ts`: after each scrape, a second
   Firecrawl call with `formats: [{ type: "json", prompt, schema }]`
   extracting `{ entityName, entityType, expressedNeed, skillsOrOffer[],
   signals[], contactRoute, confidence }`. Schema-invalid output → fall back
   to snippet-only candidates and mark the source `unextracted`. Never trust
   extracted contact data without a `publicSource` URL.
4. `ai.explainMatches` consumes entities + signals: explanations must cite
   extracted attributes and signal statements; "no public contact route" →
   `recommendedAction: research_alt_route` (Radar states what it cannot do).
5. Signal feed query: reactive per-mission signal timeline (newest first),
   the raw material for outreach personalization.

### Frontend
1. Match cards become **entity cards**: kind badge, name, extracted need or
   offer, signal chips with dates, contact route with its public source,
   evidence accordion (source links), AI summary, label, risks, unknowns.
2. Discover view gains a **Signals** tab: the per-mission signal timeline.
3. Entity drill-in: all sources, all signals, attribute history.

### Tests
Extraction schema validation + fallback; entity dedupe across duplicate
URLs; signal dedupe; explain-prompt contains entity/signal content; contact
routes without publicSource are dropped.

### Complete when
A mission's Discover view shows resolved entities with signals and contact
routes grounded in cited sources — not a list of links.

## Phase 3 — Relationship pipeline, sequences, follow-ups

The AI-SDR lesson: after discovery, Radar manages *relationships* — with
approval at every outward step.

### Backend
1. `outcomes` upgraded to a relationship pipeline:
   `stage: contacted|replied|engaged|meeting|proposal|won|lost|dormant`,
   `nextStep`, `nextStepAt`, `history: [{ at, event, reference }]`.
2. New `followUps` table `{ workspaceId, missionId, outcomeId, dueAt, note,
   status: scheduled|due|done|snoozed|cancelled }`; scheduler wake marks due
   items and surfaces an attention chip; snooze/complete reschedule via
   `ctx.scheduler`.
3. `ai.suggestNextStep` (runs after reply classification): relationship
   stage, recommended next action, and a suggested reply draft — joining the
   existing reply-draft path so a reply re-enters the approval flow.
4. **Sequences**: a plan may define a 2–3 step outreach sequence (intro →
   value-add → gentle close). Each step is an independent draft requiring its
   own approval; a step auto-queues as a draft (never sends) when its trigger
   fires (reply classified, follow-up due, no-reply window elapsed via
   scheduler). One approval = one send, unchanged.
5. `meetings` as first-class outcome events: recording a meeting is a
   mutation with the counterpart, time, and notes; shown on the timeline.

### Frontend
1. **Outcomes → Pipeline view**: columns/list by stage with counters,
   per-relationship timeline (message sent → delivered → reply → meeting →
   outcome), next-step chip with due date, snooze/complete controls.
2. Outreach view: sequence stepper per match (step 1 sent, step 2 queued as
   draft awaiting approval…).
3. Inbox: reply classification + suggested reply + one-click "turn into
   approved draft" flow (already partly built — finish the join).

### Tests
Follow-up schedule → due → wake → attention chip; snooze reschedules;
sequence step queues draft without sending; each sequence send requires its
own approval; reply classification updates pipeline stage; history appends
are idempotent.

### Complete when
From a reply, the user can go to Pipeline, see the relationship advanced,
accept a suggested next step, approve it, and watch the timeline grow —
the full "observe response → continue → record outcome" arc.

## Phase 4 — Form intelligence & approval-bound submissions

The previously out-of-scope capability, made safe: Radar can complete and
submit a public web form (application, contact form, RFP intake) **only**
with human approval of the exact payload, one submission per approval, with
screenshot evidence. Firecrawl `actions` + `screenshot` + file storage make
this real without an unattended browser.

### Backend
1. `convex/formFlows.ts`:
   - `scoutForm({ sourceId })`: Firecrawl scrape with
     `actions: [{ type: "scrape" }]`-style extraction of form structure —
     fields `{ name, label, type, required, options[] }`, submit button,
     auth/CAPTCHA indicators; persisted in `formTemplates`.
   - `proposeFill({ formTemplateId })`: LLM maps **confirmed context facts**
     onto fields → `formProposal` `{ fieldValues, unmatchedRequired[] }`;
     only `user_confirmed` facts are eligible; unmatched required fields →
     ask the user (Context screen deep-link).
   - `approveFormSubmission`: reuses the existing approval machinery —
     approval row bound to SHA-256 of the exact payload + target URL +
     capability `submit_form`, with expiry.
   - `executeFormSubmission({ proposalId })`: one approved execution = one
     scrape run with click/type/wait/press actions ending in submit; captures
     post-submit markdown + `screenshot` format; stores the image via Convex
     file storage; records `formSubmissions` `{ status: submitted |
     blocked_login | blocked_human_check | failed, evidenceFileId,
     submittedAt }`.
2. Hard boundaries in code:
   - auth wall detected → `blocked: LOGIN_REQUIRED` (never attempt);
   - CAPTCHA/challenge detected → `blocked: HUMAN_CHECK_REQUIRED`
     (detect-and-stop, never bypass);
   - no batch: one approval = one run; per-workspace daily submission cap
     enforced by a mutation check;
   - full audit trail in run steps (`form.scouted`, `form.proposed`,
     `form.approved`, `form.executed`, `form.blocked`).
3. Job-application framing: this covers audit §4 (prepare application, ask
   approval, submit, store record, show status) for public forms. Private
   portals remain explicitly blocked states, honestly surfaced.

### Frontend
1. Source/entity detail gains a **Form flow** panel: "Scout form" → extracted
   field list → editable proposal (values pre-filled from confirmed facts,
   unknowns flagged) → Approve & submit → status + screenshot evidence.
2. Blocked states render with explanation and next action (e.g. "This
   portal requires login — Radar stopped here").
3. Applications/applications-like history: `formSubmissions` listed per
   mission with target, date, status, evidence screenshot.

### Tests
Scout parses a fixture form; proposal only uses confirmed facts; unmatched
required fields block approval; approval binds to payload hash (mutated
payload → stale); execution is idempotent per approval; login/CAPTCHA
detection produces blocked-not-failed; cap enforcement.

### Complete when
Radar takes a public application/contact form from discovery to a
screenshot-evidenced submission with an approval card showing every field
value beforehand — and stops honestly at walls it must not cross.

## Phase 5 — Radar command center (product surface)

Make the whole thing feel like a product a judge could use tomorrow.

### Frontend
1. **Network overview** (new Home upgrade): live counters (missions, active
   runs, entities mapped, signals this week, conversations, pipeline value by
   stage), attention queue (approvals, due follow-ups, fresh replies,
   blocked stages).
2. **Brief-first mission console**: the plan is a living, editable artifact
   (goal, must-have, exclusions, sources, completion predicate) with
   "Radar understood" always visible and correctable.
3. Search across everything: Convex search index powers a command-bar search
   over entities, matches, threads, outcomes.
4. Accessibility + polish pass: keyboard-only mission → approval path,
   visible focus, contrast, status never color-only, empty states with
   guidance, mobile drawer parity.

### Backend
Supporting queries only (aggregates via indexes; no N+1 patterns; search
index setup for `entities`, `outcomes`, `inboxMessages`).

### Complete when
A first-time user can run the whole arc from the Home screen without
documentation, keyboard-only, at mobile width.

## Phase 6 — Hardening & operations

1. Credit/budget guard: per-workspace Firecrawl credit estimate per mission
   (search vs crawl vs extract costs), visible before "Run Radar end-to-end";
   hard cap with `FIRECRAWL_CREDITS_EXHAUSTED` surfaced as budget-blocked,
   not error.
2. Retry/backoff policy centralized in the orchestrator (bounded, classified
   by provider error code, non-retryable codes skip).
3. Idempotency sweep: every external write (crawl page ingest, message send,
   form submit, webhook event) idempotent by provider reference — reuse of
   existing patterns, verified by tests.
4. Security re-audit against docs/integrations-trust.md: untrusted-content
   bounding on every new LLM path (extraction, form mapping, next-step),
   scope checks on every new query/mutation, no secrets in logs.
5. Load sanity: a 20-query mission completes without scheduler pileup
   (stage-advance checks run status before executing).

### Complete when
The failure taxonomy from data-api.md §7 covers every new path; the trust
test suite covers extraction, forms, sequences, and follow-ups; no new
surface accepts an unapproved side effect.

## Phase 7 — Proof, video, submission

Carried from the previous plan, unchanged in substance:

1. Canonical proof run twice on production (mission → autonomous run →
   entities/signals → explanation → approval → send → delivery → reply →
   classification → suggested next step → follow-up → outcome → form-flow
   demo), capturing evidence per integration-verification.md §7.
2. Failure-path proofs: replayed/unsigned webhook, expired approval,
   tampered payload, LOGIN_REQUIRED stop.
3. Accessibility + clean-browser checks; hackathon.md finalization
   (event, stack, live URL, demo link; no secrets); social post tagging all
   four sponsors; video under three minutes following delivery-proof.md.

### Complete when
Every sponsor matrix row has live evidence; a judge can reproduce the whole
arc from the public URL; all submission artifacts are truthful and complete.

## Execution order & dependency

```
Phase 1 (orchestrator + transcript)
   └→ Phase 2 (entities/signals)   ← extraction runs inside discover/evaluate
        └→ Phase 3 (pipeline/sequences) ← consumes entities + signals
             └→ Phase 4 (form flows) ← consumes confirmed facts + approvals
                  └→ Phase 5 (command center polish)
                       └→ Phase 6 (hardening)
                            └→ Phase 7 (proof + submission)
```

Phases 3 and 4 both depend on 2 but are independent of each other; Phase 5
can proceed in parallel with 6 once 4 lands. Every phase ends green:
`npm test`, `npx tsc -b`, `npm run build`, backend push, and (from Phase 1
on) a production redeploy with the live URL re-verified.
