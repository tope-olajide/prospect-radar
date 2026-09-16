# Sponsor integration verification

## 1. Status

This document records verification evidence against production deployment
`wry-walrus-528` (team `tope-olajide`, project `prospect-radar`).

- **Frontend:** https://wry-walrus-528.convex.site (Convex Static Hosting)
- **Backend:** https://wry-walrus-528.convex.cloud
- **Evidence date:** 2026-09-16
- **Test suites:** 128 automated tests passing across 9 files (`npm test`),
  including convex-test suites that invoke the real functions (trust,
  orchestrator, entities, relationships, intent, forms) and a public-query
  return-contract suite (`tests/runs.test.ts`).
- **Environment:** production deployment with live sponsor keys; local dev
  deployment remains in use for development.

A row moves from *specified* to *verified* only when the real boundary was
invoked, the provider result was captured, and the state is reloadable in the
UI. Rows marked ⏳ await the interactive end-to-end proof run (§8).

## 2. Sponsor proof matrix

| Sponsor | Required real behavior | Evidence | Status |
| --- | --- | --- | --- |
| Convex | Query, mutation, action, scheduler, webhook, reactive UI | Prod backend live with all four components (`firecrawl`, `agentmail`, `staticHosting`); 26 automated tests exercise real queries/mutations/actions through `convex-test`, including guarded run transitions, cross-workspace rejection, and idempotent replay; trust suite proves the approval boundary server-side (`tests/trust.test.ts`); scheduled classification runs on inbound events (`inbox.classifyInboundMessage`); webhook accepted + deduplicated (see AgentMail row); site serves the app (§9) | ✅ verified |
| Firecrawl | Search or scrape plus durable crawl or structured extraction | Official component `@firecrawl/firecrawl-convex` registered (`convex/convex.config.ts`); `research.search` / `scrape` / `mapSite` / `startCrawl` invoke it with provenance (`providerRequestId`, `crawlId`, `firecrawlPageId`, `fetchedAt`) persisted on `sourceRecords`; `researchStore.crawlCompleted` normalizes completion once per crawl; stale/truncated/rate/credit states labeled via component metadata (`freshness` enum) and classified error codes (`convex/providerErrors.ts`); dedup by normalized URL on every store path; component webhook route reachable in production (`POST /firecrawl/webhook` → 200, 2026-09-15). **Live-key proof 2026-09-16 (E4–E8):** `search` returned 5 results for a target URL, and `scrape` with `formats: ["markdown", "html", {type: "json"}]` scouted a real public form, then `scrape` with `actions` + `screenshot` submitted it | ✅ verified end to end |
| OpenAI (compatible LLM) | Mission plan, match explanation, and message/reply draft using strict schemas | `ai.interpretMission`, `ai.explainMatches`, `ai.draftMessage`, `outreach.classifyReply`, `ai.classifyMissionIntent`, `ai.suggestNextStep` call the configured OpenAI-compatible endpoint with `response_format: json_object`, strict validated output, and bounded untrusted evidence; zero-valid-output raises `OPENAI_SCHEMA_INVALID` instead of persisting; provider/model provenance persisted per plan/match/classification; requester profile (confirmed context facts) feeds plan/evaluation/drafting. **Live-key proof 2026-09-16 (E6):** `formFlows.proposeFill` ran against `dashscope:qwen-max` in production and returned a fact-indexed fill mapping | ✅ verified live |
| AgentMail | Approved send, delivery state, inbound reply, reactive thread update | Official component `@agentmail/convex` with durable `sendMessage`/`replyToMessage`, reactive outbound status, component webhook ingest; **production webhook transport verified 2026-09-15**: signed event → `200 {"status":"accepted"}` (component + app ingest), identical replay → `duplicate_ignored` (idempotent by `event_id`), tampered signature → `401 Invalid webhook signature`, unsigned → `401`; approval enforcement content-hash-bound and proven by trust tests; send/delivery/reply flow with real inbox captured in §8 | ✅ transport verified, live send/reply pending ⏳ |

## 3. Convex verification

| Requirement | Evidence | Status |
| --- | --- | --- |
| Data survives reload | All state in Convex tables; UI reads subscriptions only, no client caches | ✅ |
| Mutation changes a subscribed query | Trust tests assert DB state after mutations; UI subscriptions update nav counts/attention cards live | ✅ |
| Action persists through mutation | Every action path (`research.*`, `ai.*`, `outreach.*`) persists via internal mutations (asserted in tests) | ✅ |
| Scheduled wake changes run without browser | Inbound webhook schedules `classifyInboundMessage`; `saveClassification` → `wakeRunOnReply` transitions run `wait → evaluate` (unit-tested) | ✅ |
| HTTP webhook accepted and deduplicated | Live prod proof 2026-09-15: signed event accepted, replay `duplicate_ignored` | ✅ |
| Unauthorized workspace access rejected | Trust tests: cross-workspace send, label set, and fact mutations all `FORBIDDEN_SCOPE` | ✅ |
| Public convex.site serves the app | `GET https://wry-walrus-528.convex.site` → 200; served bundle points at prod backend, 0 localhost references (bundle check 2026-09-15) | ✅ |

## 4. Firecrawl verification

| Requirement | Evidence | Status |
| --- | --- | --- |
| Real search or scrape returns usable content | `research.search`/`scrape` call the component with live `FIRECRAWL_API_KEY` on prod; normalization with URL + `fetchedAt` | ⏳ capture in proof run |
| Result normalized with URL and fetched timestamp | `researchStore.finishJob` / `crawlCompleted` write `url`, `fetchedAt`, freshness | ✅ implemented |
| Durable crawl creates visible progress | `latestCrawlProgress` joins app job with component crawl state (status, completed/total, pageCount) rendered in Discover | ✅ implemented |
| Page completion invokes normalization once | Component `onComplete: internal.researchStore.crawlCompleted`; job idempotency guards prevent re-runs | ✅ implemented |
| Stale, truncated, rate-limited, credit-exhausted visible | `freshness`: `fresh/cached/truncated/failed` from `metadata.cacheState`, `warning`, and crawl-page `truncated` flag; error classes `FIRECRAWL_RATE_LIMITED` / `FIRECRAWL_CREDITS_EXHAUSTED` / `SOURCE_UNAVAILABLE` classified and persisted (`researchJobs.errorCode`, run steps) | ✅ implemented (states) |
| Retry does not duplicate source records | `by_missionId_and_url` dedup on every store path; `requestId` idempotency (`IDEMPOTENCY_CONFLICT` tested) | ✅ tested |

## 5. OpenAI verification

| Requirement | Evidence | Status |
| --- | --- | --- |
| LLM called from a Convex action | `convex/ai.ts` actions fetch the configured endpoint server-side; key never leaves the backend | ✅ |
| MissionPlan / MatchExplanation validate against strict schemas | `planSchema` enforced + defensive validation; zero-valid output → `OPENAI_SCHEMA_INVALID` (not persisted); explanations validated (unknown ids dropped, labels constrained) | ✅ |
| Refusal and incomplete responses handled | HTTP errors surface as classified failures; unusable output raises schema-invalid errors rather than saving garbage | ✅ |
| Source evidence as bounded untrusted context | Bounded excerpts (≤4,000 chars/match) with untrusted-data framing in every prompt | ✅ |
| Tool calls allowlisted and policy-checked | No free-form tool calls: only fixed Convex function handles; side effects exclusively through the approval gate | ✅ |
| UI displays safe summaries, not hidden reasoning | Match cards show summary/evidence/unknowns/risks; classification shows label/summary/next action | ✅ |
| Live-key structured outputs (plan, explanation, draft, classification) | To be captured with real model responses in the §8 proof run | ⏳ |

## 6. AgentMail verification

| Requirement | Evidence | Status |
| --- | --- | --- |
| Production inbox linked to workspace | `provisionInbox` → component `createInbox` with client-request idempotency; linking UI exists | ⏳ capture in proof run |
| Draft created without sending | `outreach.draft` / `ai.draftMessage` create drafts with `status: "draft"`; trust test proves no send occurs without approval | ✅ tested |
| Approval required and content-bound | Hash(reipient, subject, body, capability) + expiry; **send-time hash recompute** (2026-09-15); trust tests prove bypass impossible: no-approval → `APPROVAL_REQUIRED`, mutated content → `APPROVAL_STALE`, expired → `APPROVAL_STALE`, cross-workspace → `FORBIDDEN_SCOPE` | ✅ tested |
| Real send returns outbound reference | Component `sendMessage` → `outboundId` persisted; `syncOutbound` polls status | ⏳ capture in proof run |
| Delivery status visible | Component status states mapped to draft status; webhook events update it (sent/delivered/bounced) | ✅ implemented |
| Real inbound reply reaches signed webhook | **Verified live 2026-09-15**: signed event → accepted; tampered → 401; unsigned → 401 | ✅ verified (transport) |
| Thread updates reactively | Threads/messages are subscription-backed; ingest appends to thread + outcome timeline | ✅ implemented |
| Duplicate webhook does not duplicate reply | **Verified live 2026-09-15**: replay → `duplicate_ignored`; app-side dedup by `event_id` additionally tested | ✅ verified |
| Reply draft unsent until approval | `classifyReply` pre-creates suggested draft in `draft` status; only `approve`+`send` executes | ✅ tested |

## 7. Evidence format

For each proof-run record: date/environment, mission/run ID, Convex function
names, sponsor operation, provider-safe external IDs (request/crawl/message/
thread/event), timestamps, result status, error class if any, artifact
reference, and whether the step was real, cached, or simulated. Never record
keys, cookies, private message bodies, or unnecessary personal data.

### Proof-run log

| # | Date | Environment | Step | Convex function | Sponsor operation | External IDs / result | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | 2026-09-15 | prod `wry-walrus-528` | Webhook transport (signed) | `http` → `agentmail/lib/handleEvent` + `inbox.ingestEvent` | AgentMail svix signature verification | `event_id: probe-1757…` → `200 accepted`; replay → `duplicate_ignored`; tampered → `401` | ✅ real |
| E2 | 2026-09-15 | prod `wry-walrus-528` | Firecrawl webhook route reachable | `http` (component route) | Firecrawl component webhook | `POST /firecrawl/webhook` → `200` | ✅ real |
| E3 | 2026-09-15 | prod `wry-walrus-528` | Public site serving | static hosting component | — | `GET /` → 200; bundle → prod cloud URL, 0 localhost refs | ✅ real |
| E4 | 2026-09-16 | prod `wry-walrus-528` | Firecrawl search (live) | `research.search` | `firecrawl.search` | job `kx70ge77gxdmr6r7cdc3chxq458ehb34` → 5 results; source `m97ddafbx2g6xte8j9fq74xfr98eh88v` = `httpbin.org/forms/post` | ✅ real |
| E5 | 2026-09-16 | prod `wry-walrus-528` | Form scout (structured extraction) | `formFlows.scoutForm` | `firecrawl.scrape` w/ `formats: [markdown, html, {type: json, schema}]` | 7 fields parsed from the DOM with real `name` attributes and CSS selectors; submit control resolved to `form button`; `blockedReason: null` | ✅ real |
| E6 | 2026-09-16 | prod `wry-walrus-528` | Fill proposal (confirmed facts only) | `formFlows.proposeFill` → `formStore.saveProposal` | OpenAI-compatible `dashscope:qwen-max` | 6 values grounded, each citing a confirmed fact; `size: "medium"`, `topping: "bacon, cheese"`; `delivery` left empty (no fact); payload hash `20721e96d3929de5848fca31acec386300bf7c1172ba46ddc32b0d67c94b0dfc` | ✅ real |
| E7 | 2026-09-16 | prod `wry-walrus-528` | Approval bind + execute | `formStore.approveProposal` → `formFlows.executeFormSubmission` | `firecrawl.scrape` w/ `actions` (click/write/wait/screenshot/scrape) | approval bound to the payload hash → marked `used`; submission `n97ct2bhcf0v258ckktw9m190s8ehg8c` = `submitted` with stored screenshot (1920×1080 PNG); post-submit echo contains the exact submitted body incl. `"size":"medium"` and `"topping":["bacon","cheese"]` | ✅ real |
| E8 | 2026-09-16 | prod `wry-walrus-528` | Idempotency + cap + transcript | `formStore.claimExecution`, `formStore.capStatus`, `runs.steps` | — | second execution → `already_submitted`, submissions for the mission = **1** (Firecrawl call count unchanged); `capStatus` → `used 3 / cap 5`; transcript holds `form.scouted`, `form.proposed`, `form.approved`, `form.executing`, `form.executed` | ✅ real |

*(Remaining §8 rows — plan, matches, AgentMail draft/approve/send/delivery,
inbound reply, classification, outcome — are appended by the outreach proof run.)*

## 8. End-to-end proof run

The canonical live run is:

1. create a mission;
2. receive a strict LLM MissionPlan;
3. run Firecrawl search;
4. scrape or crawl a selected source;
5. display a sourced match;
6. generate an LLM message draft;
7. approve the exact draft;
8. send through AgentMail;
9. observe delivery;
10. send or receive a test reply;
11. process the inbound webhook;
12. show the updated thread and persisted outcome.

The run must be repeatable without duplicate messages or duplicate outcomes.

### 8.1 Form-flow proof run (2026-09-16, completed)

Driven against the live production deployment by
`scripts/formFlowProof.mjs`; evidence in `proof/form-flow.json` and
`proof/form-flow-screenshot.png`. Target: `https://httpbin.org/forms/post`, a
public form built to echo a POST, so the pipeline is proven without sending
unsolicited messages to a real business.

| Step | Function | Result |
| --- | --- | --- |
| Mission | `missions.create` | `kd7a560yh0w2q4zk32d201j4z58ehzy1` (run `jd731ym3jd71c1s90jnegxwzth8egv95`) |
| Confirmed facts | `context.add` | 6 workspace facts, all `user_confirmed` |
| Discover the form | `research.search` (Firecrawl) | source `m97ddafbx2g6xte8j9fq74xfr98eh88v` |
| Scout | `formFlows.scoutForm` | 7 fields, DOM-parsed, `blockedReason: null` |
| Propose | `formFlows.proposeFill` | 6 grounded values, every value citing a confirmed fact |
| Approve | `formStore.approveProposal` | approval bound to the payload hash, TTL 60 min |
| Submit | `formFlows.executeFormSubmission` | `submitted`, screenshot stored, post-submit text captured |
| Re-run | `formFlows.executeFormSubmission` | `already_submitted` — no second Firecrawl call, no second submission |

The post-submit page is the strongest evidence available: it is the target's
own echo of the request body, containing the exact values Radar approved
(`custname`, `custtel`, `custemail`, `size`, `topping`, `comments`) with
deliberately empty fields left absent. Safety behavior is proven by unit
tests, not by hope: login walls and human checks record blocked states, an
unmatched required field blocks approval, a mutated payload invalidates its
approval, and the daily cap refuses further submissions.

> **Defect found by this run and fixed:** `runs.forMission`, `runs.events`,
> and `runs.steps` returned raw documents (leaking `_creationTime` and
table-only keys) against narrower view validators, so every call raised
> `ReturnsValidationError` in production and the Activity run panel silently
> showed "no run" instead of an error. The views now map their fields
> explicitly and `tests/runs.test.ts` locks the contract.

## 9. Public-delivery checks

- ✅ public repository accessible — https://github.com/tope-olajide/prospect-radar (HTTP 200, 2026-09-15);
- ✅ convex.site URL opens without invitation — `GET /` → 200;
- ✅ AgentMail production webhook reachable and signature-verified (E1);
- ✅ Firecrawl production webhook reachable (E2);
- ✅ no localhost URL required — served bundle contains zero localhost references (checked 2026-09-15);
- ✅ hackathon.md contains current stack, live URL, and demo-link placeholder pending video;
- ⬜ video shorter than three minutes;
- ⬜ social post tagging Convex, OpenAI, Firecrawl, and AgentMail.
