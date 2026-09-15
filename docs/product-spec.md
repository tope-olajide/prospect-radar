# Product specification

## 1. Product promise

Prospect Radar turns an ambiguous opportunity goal into a sourced, explainable,
approval-safe next step.

It is not a job board, CRM, marketplace, mass-mailer, or generic chat window.
It is a mission workspace that connects discovery, reasoning, communication, and
relationship memory.

## 2. Users and modes

The same workspace supports:

- **Find an opportunity:** identify roles, projects, grants, or partnerships.
- **Find a person:** identify a specialist, contractor, cofounder, or collaborator.
- **Find a customer:** identify an organization showing a relevant public signal.
- **Find a solution:** identify a provider for a concrete problem.

The mode is editable. A user may keep several missions active at once.

## 3. Default demo journey

The representative demo is a product professional looking for a small company
with a complex workflow problem:

1. The user writes the goal in the command composer.
2. OpenAI returns a typed interpretation and asks only high-impact questions.
3. Firecrawl searches public sources and scrapes the strongest evidence.
4. Radar presents ranked matches with URLs, dates, fit reasons, unknowns, and risks.
5. OpenAI drafts a specific, evidence-based introduction.
6. The user approves the exact draft.
7. AgentMail sends it from the Radar inbox.
8. A reply arrives through the AgentMail webhook and appears live in the inbox.
9. Radar classifies the reply, suggests a next step, and records the outcome.

The other modes use the same flow and contracts.

## 4. Product principles

- **Intent before configuration:** understand the goal before presenting filters.
- **Evidence before confidence:** every consequential claim has provenance or is explicitly marked as an inference.
- **Public sources only by default:** Radar does not bypass access controls.
- **Approval at the side-effect boundary:** drafting can be autonomous; sending, publishing, sharing, or committing requires approval.
- **Agent-owned inbox:** conversations remain durable and inspectable after a run ends.
- **Calm autonomy:** routine in-scope work continues; meaningful decisions interrupt.
- **No invented credibility:** Radar never fabricates experience, results, pricing, availability, identity, or provider receipts.
- **One product, many directions:** mode-specific language must not create four disconnected applications.

## 5. Functional requirements

### Mission intake

- Accept a natural-language goal.
- Produce a MissionPlan with mode, constraints, source scope, missing facts, and completion predicate.
- Allow the user to correct the interpretation before research begins.

### Public-web discovery

- Search public sources with Firecrawl.
- Map a domain before a larger crawl when useful.
- Scrape pages into markdown or structured JSON.
- Run durable crawls whose progress is persisted and visible.
- Store source URL, title, timestamp, freshness, extraction status, and evidence.

### Matching and research

- Normalize heterogeneous public signals into one source model.
- Rank candidates using explainable factors rather than fake precision.
- Show positives, unknowns, risks, source freshness, and recommended action.
- Keep the original source reference for every material claim.

### AgentMail inbox

- Maintain an inbox per workspace or demo identity.
- Link threads to missions, matches, and outcomes without duplicating full bodies.
- Support labels such as new, approved, waiting, reply, and closed.
- Draft messages and replies without sending.
- Send only after an approval bound to recipient and content hash.
- Process inbound messages through a verified webhook.
- Track delivery states reactively.

### Outcome memory

- Preserve the mission, evidence, communication, reply, and next action.
- Distinguish active work from waiting, blocked, failed, and complete.
- Let the user correct, close, delete, or reopen an outcome.

## 6. Non-goals for the hackathon release

- mass or deceptive outreach;
- private or restricted scraping;
- automatic commitments, purchases, bookings, or applications;
- a full CRM, ATS, payment system, or social network;
- pretending that the two-sided network is live before it is verified;
- exposing chain-of-thought or raw provider payloads to users.

## 7. Success criteria

The release is successful when a new user can:

1. enter a mission without learning a schema;
2. see useful, source-backed results;
3. understand why a match was recommended;
4. approve one precise message;
5. watch the message become delivered;
6. receive and inspect a reply in the live inbox;
7. understand the next action and current outcome state.

Hackathon success additionally requires the sponsor proof and public-delivery
requirements in integration-verification.md and delivery-proof.md.
