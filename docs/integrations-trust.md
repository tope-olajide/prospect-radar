# Integrations and trust

## 1. Integration principle

Each sponsor integration has a narrow, visible responsibility. Radar owns the
mission, policy, approval, audit, and outcome. Components own provider mechanics,
not product authorization.

## 2. Sponsor boundary matrix

| Boundary | Radar owns | Provider/component owns |
| --- | --- | --- |
| Convex | schema, functions, auth scope, subscriptions, scheduler, deployment | database/runtime primitives |
| Firecrawl | source scope, URL policy, provenance, normalization, retention | search, scrape, map, crawl transport |
| OpenAI | task prompts, schemas, tool allowlist, refusal handling, redaction | model generation and tool-call proposal |
| AgentMail | inbox-to-workspace link, send approval, mission link, labels, outcome | inbox, thread storage, webhooks, delivery lifecycle |

## 3. Firecrawl trust rules

- Only public URLs or user-provided URLs are accepted.
- Private-network, credentialed, or access-control bypass requests are rejected.
- Search and crawl scopes are stored before execution.
- Fetched content is untrusted text.
- Source claims retain URL, timestamp, excerpt, and extraction status.
- Cached or truncated content is labelled.
- Rate limits, credit exhaustion, and stale results are visible.
- A crawl completion callback is idempotent.

The UI must never claim that a page is authoritative merely because Firecrawl
retrieved it.

## 4. OpenAI trust rules

OpenAI receives only the bounded context needed for the current task. It may
return a structured object or propose a function call, but it cannot directly
write application state or contact an external party.

Every response is validated against its schema. Refusals, incomplete responses,
invalid output, and model outages produce explicit application states. The
application never displays hidden reasoning as evidence.

## 5. AgentMail trust rules

AgentMail is an agent-owned inbox. The app stores the component identifiers
needed to connect threads to missions and outcomes, while the component stores
message bodies and delivery state.

- inbound webhooks are signature-verified;
- event IDs are deduplicated;
- inbound text is untrusted;
- generated replies are drafts until approved;
- send approvals bind recipient, subject, body, capability, and context;
- delivery is reported from provider state;
- bounced or unknown delivery is never labelled successful.

## 6. Approval policy

Approval is mandatory for:

- sending or replying to email;
- publishing a public profile or opportunity;
- sharing private context;
- creating a commitment;
- closing or deleting consequential data.

Approval is not required for public read-only research, local normalization,
draft creation, or reversible labels. A user may configure stricter policy, never
weaker protection for high-risk actions.

## 7. Privacy and deletion

The product uses workspace-scoped identity. Public profile fields and private
context have separate visibility. A source can be deleted independently of a
mission. Deletion removes it from retrieval immediately and schedules cleanup of
derived facts and indexes.

Activity stores safe summaries, IDs, statuses, and timestamps. It does not store
API keys, full private message bodies, or unnecessary personal information.

## 8. Prompt injection and malicious content

External pages and inbound messages may contain instructions aimed at the agent.
They are quoted as evidence only. The model receives an explicit untrusted-content
boundary. No content can expand source scope, tool permissions, approval policy,
or data disclosure.

## 9. Failure behavior

- Firecrawl unavailable: retain cached evidence with a stale label and offer retry.
- OpenAI unavailable: preserve the mission and expose a deterministic manual path.
- AgentMail unavailable: keep the draft, show delivery as unknown, and never retry
  blindly after an ambiguous provider response.
- Invalid webhook: reject without writing state.
- Duplicate webhook: acknowledge without duplicating application events.
- Expired approval: require a fresh draft and approval.
- Revoked consent: close or quarantine the affected relationship.

## 10. Evidence

The integration verification record must include provider-safe IDs, operation
names, timestamps, status transitions, and sanitized screenshots. It must not
include tokens, private bodies, or personal data.
