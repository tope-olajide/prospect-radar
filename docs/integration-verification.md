# Sponsor integration verification

## 1. Status

This document is the verification contract, not evidence of completed integration.
At the time of this rewrite the repository contains documentation only.

A row may move from specified to verified only when the real boundary is invoked,
the provider result is captured, and the UI can reload the persisted state.

## 2. Sponsor proof matrix

| Sponsor | Required real behavior | Evidence |
| --- | --- | --- |
| Convex | Query, mutation, action, scheduler, webhook, and reactive UI update | Function names, run IDs, reload proof, sanitized screenshots |
| Firecrawl | Search or scrape plus durable crawl or structured extraction | Query/URL, Firecrawl job ID, page IDs, fetched time, source links |
| OpenAI | Mission plan, match explanation, and message or reply draft using strict schemas | Task names, schema names, result status, refusal handling, safe output |
| AgentMail | Approved send, delivery state, inbound reply, reactive thread update | Inbox ID, outbound/message/thread IDs, event ID, timestamps, screenshots |

## 3. Convex verification

Pass only when:

- data survives a page reload;
- a mutation changes a subscribed query;
- an action persists its result through a mutation;
- a scheduled wake changes a run without a browser request;
- an HTTP webhook is accepted and deduplicated;
- unauthorized workspace access is rejected;
- the public convex.site URL serves the application.

## 4. Firecrawl verification

Pass only when:

- a real search or scrape returns usable content;
- the result is normalized with URL and fetched timestamp;
- a durable crawl creates visible progress;
- page completion invokes normalization once;
- stale, truncated, rate-limited, and credit-exhausted states are visible;
- a retry does not create duplicate source records.

Local polling may verify development behavior, but production webhook evidence
is required before claiming the deployed crawl path is complete.

## 5. OpenAI verification

Pass only when:

- the Responses API is called from a Convex action;
- MissionPlan and MatchExplanation outputs validate against strict schemas;
- refusal and incomplete responses are handled;
- source evidence is included as bounded untrusted context;
- tool calls are allowlisted and policy-checked;
- the UI displays safe summaries rather than hidden reasoning.

## 6. AgentMail verification

Pass only when:

- the production inbox is linked to the workspace;
- a draft is created without sending;
- approval is required and content-bound;
- a real send returns an outbound reference;
- delivery status is visible;
- a real inbound reply reaches the signed webhook;
- the linked thread updates reactively;
- duplicate webhook delivery does not duplicate the reply;
- a reply draft remains unsent until approval.

## 7. Evidence format

For each proof run record:

- date and environment;
- mission/run ID;
- Convex function names;
- sponsor operation;
- provider-safe external IDs;
- start and end timestamps;
- result status;
- retry or error class;
- screenshot path or screen recording timestamp;
- whether the step was real, cached, or simulated.

Never record keys, cookies, private message bodies, or unnecessary personal data.

## 8. End-to-end proof run

The canonical live run is:

1. create a mission;
2. receive a strict OpenAI MissionPlan;
3. run Firecrawl search;
4. scrape or crawl a selected source;
5. display a sourced match;
6. generate an OpenAI message draft;
7. approve the exact draft;
8. send through AgentMail;
9. observe delivery;
10. send or receive a test reply;
11. process the inbound webhook;
12. show the updated thread and persisted outcome.

The run must be repeatable without duplicate messages or duplicate outcomes.

## 9. Public-delivery checks

- public repository is accessible;
- convex.site URL opens without invitation;
- Firecrawl and AgentMail production webhooks are reachable;
- no localhost URL is required;
- hackathon.md contains the current stack, live URL, and demo link;
- video is shorter than three minutes;
- social post tags Convex, OpenAI, Firecrawl, and AgentMail.
