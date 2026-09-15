# Prospect Radar

## Product brief

Prospect Radar helps a person or small team move from “I need the right
opportunity, person, customer, provider, or collaborator” to a trusted next
step. The user describes a mission in ordinary language. Radar interprets the
mission, researches public evidence, explains the best matches, prepares a
respectful message, and keeps the resulting conversation and outcome visible.

The four product modes are:

1. **Find an opportunity** — roles, contracts, grants, partnerships, or projects.
2. **Find a person** — a specialist, contractor, cofounder, or collaborator.
3. **Find a customer** — an organization showing a relevant need.
4. **Find a solution** — a person or business that can solve a concrete problem.

The vocabulary changes with the mode, but the underlying mission, evidence,
matching, approval, inbox, and outcome model stays the same.

## Sponsor-native architecture

| Sponsor | Real product responsibility | Proof required |
| --- | --- | --- |
| Convex | Database, typed functions, reactive subscriptions, scheduling, webhooks, and deployment | Queries, mutations, actions, live UI updates, durable run state |
| Firecrawl | Public-web search, page extraction, site mapping, durable crawls, and source provenance | A real search/scrape and a crawl or structured extraction |
| OpenAI | Mission interpretation, structured extraction, ranking explanations, reply classification, and drafting | Real Responses API calls with strict schemas and tool boundaries |
| AgentMail | Agent-owned inbox, threads, labels, approved sending, inbound events, and delivery state | Real send, inbound reply, reactive thread update, and delivery receipt |

The app will use the official Convex components for
[Firecrawl](https://www.convex.dev/components/firecrawl/firecrawl-convex) and
[AgentMail](https://www.convex.dev/components/agentmail/convex). The model
layer follows the official OpenAI guidance for
[Responses tools](https://developers.openai.com/api/docs/guides/tools) and
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Hackathon contract

The implementation must satisfy the Convex All Gas requirements:

- new application started during the event window;
- Convex is the backend;
- the frontend is publicly reachable at a convex.site URL;
- the repository is public;
- hackathon.md records the event, stack, live URL, and demo link;
- OpenAI, Firecrawl, and AgentMail perform real work;
- the app is shared while tagging the sponsors on X or LinkedIn;
- the final submission uses the exact Vibeapps form and includes a video under
  three minutes.

See the [official hackathon page](https://www.convex.dev/hackathons/all-gas) and
[event listing](https://luma.com/convex-allgas) for the live rules.

## Canonical runtime flow

mission → OpenAI MissionPlan → Convex durable run → Firecrawl discovery and
evidence → OpenAI explanation and draft → human approval → AgentMail send →
inbound reply webhook → OpenAI classification and follow-up → Convex outcome

The browser subscribes to Convex queries. It never owns provider secrets,
authoritative scores, approval decisions, or run progress.

## Documentation map

- [Product specification](product-spec.md) — product promise, users, modes, scope, and success criteria.
- [UX specification](ux-spec.md) — mission workspace, discovery, inbox, approvals, and responsive states.
- [Agent and context model](agent-context.md) — context, provenance, untrusted content, and run behavior.
- [Technical architecture](technical-architecture.md) — Convex functions, components, webhooks, and deployment.
- [Data and API contracts](data-api.md) — schemas, function namespaces, state machines, and typed interfaces.
- [Integrations and trust](integrations-trust.md) — sponsor boundaries, privacy, approvals, and failure handling.
- [Implementation TODO](implementation-todo.md) — current build checklist and deferred form-filling design.
- [Product decisions and FAQ](faq-and-decisions.md) — decisions that prevent scope drift.
- [Integration verification](integration-verification.md) — live sponsor proof and evidence format.
- [Delivery and proof](delivery-proof.md) — tests, demo script, and judging evidence.

## Documentation status

This repository is documentation-only at the time of this rewrite. Every
feature is therefore **specified**, not automatically **implemented** or
**verified**. Future updates must use these labels consistently:

- **Specified** — the behavior and contract are documented.
- **Implemented** — code exists and passes local checks.
- **Verified** — the real boundary has reproducible evidence.
- **Public-ready** — verification, privacy, accessibility, and deployment gates pass.
