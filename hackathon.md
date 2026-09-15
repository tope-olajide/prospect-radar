# Convex All Gas submission

## Event

Convex All Gas Hackathon — `https://www.convex.dev/hackathons/all-gas`

## Project

**Prospect Radar** turns a natural-language opportunity goal into sourced matches, explainable research, explicitly approved AgentMail outreach, and a live outcome trail.

## Stack

- Convex: schema, functions, durable state, reactive UI, scheduling, webhooks, and deployment.
- Firecrawl via the official `@firecrawl/firecrawl-convex` component: public-web search, scrape, map, durable crawls with completion callbacks, structured evidence, and provenance.
- OpenAI-compatible LLM (`OPENAI_BASE_URL` / `OPENAI_MODEL`, real OpenAI by default): structured mission planning and reply classification with suggested follow-up drafts.
- AgentMail via the official `@agentmail/convex` component: agent-owned inboxes, durable approved sends, delivery receipts, inbound threads, and labels.

## Build log

- Mission lifecycle, durable runs, and guarded stage transitions implemented on Convex.
- Firecrawl discovery (search, scrape, map, durable crawl) migrated onto the official Convex component with provenance, deduplication, and run-state transitions.
- AgentMail outreach (inbox provisioning, approval-bound content-hash sends, durable outbound state, delivery webhooks, inbound replies, reply classification) migrated onto the official Convex component.
- Automated tests cover approval hashing, content bounding, URL normalization, and provider payload guards (`npm test`).

## Links

- Public repository: https://github.com/tope-olajide/prospect-radar
- Live application: pending public Convex deployment
- Demo video: pending
- Social post: pending

## Truthful status

This file is intentionally incomplete until a public deployment, video, and social post exist. It must be updated with those verified links before submission; no placeholder is a claim of completion.
