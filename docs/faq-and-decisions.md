# Product decisions and FAQ

## 1. Is Radar a job board?

No. It is a mission workspace for opportunity discovery and trusted next steps.
The mode may be job-seeking, client-seeking, hiring, sourcing, or problem-solving.

## 2. What does Convex do?

Convex is the application backend: data, typed queries and mutations, server
actions, scheduling, webhooks, live subscriptions, and deployment.

## 3. What does Firecrawl do?

Firecrawl supplies public-web search, page extraction, site mapping, durable
crawls, and source evidence. Radar stores provenance and explains freshness.

## 4. What does OpenAI do?

OpenAI interprets goals, extracts structured facts, explains matches, classifies
replies, and drafts respectful actions. Convex validates every result and owns
execution policy.

## 5. What does AgentMail do?

AgentMail gives Radar a durable agent-owned inbox with threads, labels, inbound
webhooks, delivery tracking, and reactive updates. A draft is not a sent message.

## 6. Can the agent send without permission?

Not for consequential outreach. Sending and replying require an approval bound to
the exact recipient and content. The approval becomes invalid if the draft changes.

## 7. Does Radar read private websites?

No. The default source scope is public web pages and explicitly supplied URLs.
Access-control bypass is out of scope.

## 8. Is every match factually true?

No. A match is a decision aid. Each explanation separates evidence, inference,
unknowns, freshness, and risks.

## 9. What happens when there are no results?

Radar explains which constraint limited discovery and offers broaden, retry,
provide a URL, or keep watching. It does not invent candidates.

## 10. What happens when a source is stale?

The result remains visible with a stale label and its fetched timestamp. Radar
can refresh it or exclude it from a consequential recommendation.

## 11. What happens when an email arrives?

AgentMail verifies and stores the inbound event. Convex updates the linked thread,
then schedules OpenAI classification. Radar may propose a reply or next action,
but it does not send automatically.

## 12. Why is there a network tab?

The two-sided network supports consented internal matching. It is specified as a
privacy-first extension and must display preview status until verified.

## 13. Is authentication required?

The hackathon permits apps without auth. The production contract is workspace
scoped. A public demo may use a judge-friendly demo workspace, but cross-user
privacy claims require real identity tests.

## 14. What is simulated?

A simulated result is labelled simulated in the UI and never counts as sponsor
proof. The final evidence must identify which Firecrawl, OpenAI, AgentMail, and
Convex boundaries were real.

## 15. What happens if the model refuses?

The run records an OpenAI refusal and offers a manual edit or retry path. A refusal
never becomes an empty success.

## 16. What happens if sending is ambiguous?

The action becomes unverified. Radar does not blindly resend. The user is shown
the provider reference or asked to confirm the external state.

## 17. What must be in the public repository?

The source, current docs, root hackathon.md, live URL, sponsor stack, and
reproducible verification instructions. Secrets and private evidence are excluded.

## 18. What is the final definition of done?

A judge can open the public URL, run the representative mission, see sourced
matches, approve a draft, observe AgentMail delivery and an inbound reply, and
inspect the persisted outcome. The build log and evidence matrix agree with what
is actually live.
