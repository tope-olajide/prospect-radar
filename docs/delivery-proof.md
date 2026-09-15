# Delivery and proof plan

## 1. Delivery strategy

Build one polished mission loop first, then expose the multi-mode model around it.
The demo must show behavior, not claims.

The proof hierarchy is:

1. local contract tests;
2. real provider boundary tests;
3. end-to-end sponsor run;
4. public clean-browser run;
5. video and submission evidence.

## 2. Test strategy

### Unit and validator tests

Cover:

- MissionPlan, Match, ActionDraft, Approval, Run, InboxLink, and Outcome validators;
- malformed OpenAI objects;
- missing source references;
- invalid status transitions;
- workspace ownership;
- content-hash changes;
- idempotency keys.

### Convex function tests

Cover:

- query and mutation authorization;
- action result persistence;
- scheduler wake-up;
- webhook signature handling;
- duplicate event handling;
- reload after every major transition.

### Firecrawl tests

Cover:

- search result normalization;
- scrape provenance;
- map-to-crawl flow;
- crawl progress and completion callback;
- page truncation;
- stale content;
- rate limit and credit exhaustion;
- normalization exactly once.

### OpenAI tests

Cover:

- mission interpretation;
- strict output validation;
- refusal;
- incomplete response;
- unsupported claim rejection;
- bounded untrusted-source context;
- tool allowlist enforcement.

### AgentMail tests

Cover:

- draft creation;
- approval-bound send;
- delivery status;
- inbound webhook;
- thread subscription;
- labels;
- duplicate event;
- delivery failure;
- ambiguous provider response.

### End-to-end test

The real test creates a mission, invokes Firecrawl, generates an OpenAI draft,
approves it, sends through AgentMail, receives a reply, updates the thread, and
persists an outcome without duplicate side effects.

## 3. Demo script under three minutes

Suggested timing:

- 0:00–0:20 — enter a natural-language mission;
- 0:20–0:45 — show OpenAI’s editable mission interpretation;
- 0:45–1:15 — show Firecrawl-backed matches and evidence;
- 1:15–1:40 — open the generated message and approval boundary;
- 1:40–2:00 — approve and show AgentMail delivery;
- 2:00–2:25 — show the inbound reply appear in the live thread;
- 2:25–2:50 — show classification, Activity, and Outcome;
- 2:50–3:00 — state the sponsor stack and public URL.

The video must click through the real product. Avoid a long architecture lecture.

## 4. Proof artifacts

Capture:

- public URL;
- repository URL;
- hackathon.md;
- source and crawl evidence;
- OpenAI structured-result evidence;
- AgentMail delivery and inbound-event evidence;
- sanitized screenshots;
- test output;
- exact demo recording;
- social post URL.

## 5. Accessibility and public checks

Before recording:

- keyboard through the mission and approval path;
- verify readable contrast and visible focus;
- test mobile layout;
- open the app in a clean browser;
- confirm no local environment is required;
- confirm all source links work;
- confirm no secret or private data appears.

## 6. Risk controls

- **Scope risk:** keep the multi-mode contract but demonstrate one journey.
- **Fake-AI risk:** show structured results tied to source evidence.
- **Fake-integration risk:** capture provider-safe receipts.
- **Unsafe-send risk:** enforce approval server-side.
- **Stale-data risk:** show fetched time and refresh state.
- **Webhook risk:** sign and deduplicate events.
- **Empty-demo risk:** prepare a real, repeatable public mission.
- **Submission risk:** complete the public URL, build log, social post, and video
  before opening the final form.

## 7. Final checklist

- [ ] Convex queries, mutations, actions, scheduling, and live updates are real.
- [ ] Firecrawl search/scrape and crawl or structured extraction are real.
- [ ] OpenAI structured planning, explanation, and drafting are real.
- [ ] AgentMail approved send, delivery, inbound reply, and reactive thread are real.
- [ ] Approval cannot be bypassed.
- [ ] Duplicate events and retries are safe.
- [ ] Public convex.site URL works without invite.
- [ ] Public repository and hackathon.md are current.
- [ ] Video is under three minutes.
- [ ] Evidence and docs contain no secrets.
