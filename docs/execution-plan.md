# Execution plan to release readiness

This plan covers every 🟡 partial and ❌ missing item from the full audit of
the docs directory, ordered so the demo-critical path closes first and
deployment unblocks verification as early as possible. Deadline: September 22,
12:00 PM PT.

Explicitly deferred (documented, not silently missing): the two-sided network,
Firecrawl Interact form filling, real authentication beyond the demo workspace,
and the full deletion/retention pipeline.

## Phase 1 — Demo-critical code (target: 1 session)

### Tasks
1. [ ] `ai.draftMessage`: given `missionId` + `matchId`, the LLM produces
   recipient, subject, and body grounded in that match's stored evidence, and
   the result enters the existing approval-bound draft flow unchanged.
2. [x] Approval card enrichment: drafts now render as approval cards showing
   context used (linked match), the single side effect, approval expiry, and
   the provider message reference after sending.
3. [~] Crawl progress: the Activity view lists crawl jobs with crawl IDs and
   status; a reactive component-level `getCrawl` progress line is still open.
4. [~] Match detail: cards show label, evidence, unknowns, risks, AI summary,
   and recommended action inline; a drill-in view is still open.
5. [x] Application shell per ux-spec.md §2: sidebar navigation (Radar brief,
   Discover, Outreach, Inbox, Outcomes, Activity) with counts, topbar with
   live status and attention chip, and a mobile drawer. Implemented with a
   decision-first UX: attention cards surface approvals, missing facts, and
   fresh replies on Home; quick prompts seed the composer; source links are
   descriptive (hostname + fetched time).

### Complete when
- [ ] From the UI alone a user can run: mission → plan → search → explain →
  AI-drafted message → approve (with the full approval card) → send, without
  typing a message body.
- [x] Every primary screen (Home, Discover, Outreach, Inbox, Activity,
  Outcomes) is reachable through the shell navigation at desktop and mobile
  widths; the topbar shows live status and an attention chip on every screen.
- [ ] Crawl progress is visible reactively from the Firecrawl component's own
  crawl state, not only the app job list.
- No model output can reach a send without an approval row whose content hash
  matches the persisted draft (unchanged enforcement).
- `npm test`, `npx tsc -b`, `npm run build`, and `npx convex dev --once` all pass.

## Phase 2 — Contract and trust completeness (target: 1 session)

### Tasks
1. ContextFact model: table, `context.confirmFact` / `rejectFact` /
   `deleteSource` mutations, and a Context section in the UI.
2. Run step records: per-stage input/output references persisted on the run.
3. `inbox.setLabel` mutation and label display in the inbox.
4. Outcome delete and reopen actions.
5. Stale/truncated labeling on source records from component metadata.
6. Error-class alignment: map provider failures to the documented classes
   (`FIRECRAWL_RATE_LIMITED`, `FIRECRAWL_CREDITS_EXHAUSTED`,
   `AGENTMAIL_DELIVERY_FAILED`, `DUPLICATE_EVENT`, …).
7. Event vocabulary additions: `crawl.started/page_ready/completed`,
   `action.drafted`, `outcome.created/updated`.
8. Interaction-state matrix (ux-spec.md §4): loading, empty, partial, stale,
   waiting-for-approval, waiting-for-connection, retryable failure, blocked,
   and complete-with-evidence states implemented for every async surface, and
   every external result labelled real, cached, inferred, or simulated.
9. Copy rules (ux-spec.md §6): the UI says "drafted" / "sent" / "delivered" /
   "unverified" — never "contacted" for a draft — and source links are
   descriptive rather than bare URLs.
10. Tests for: validator rejection, workspace authorization, duplicate-event
   idempotency, approval bypass (send without approval fails), expired approval
   (`APPROVAL_STALE`), and content mutation invalidating an approval.

### Complete when
- Implemented features use the documented error classes and event names.
- Every async surface shows the required interaction states, including stale
  and partial results, and no status label overstates delivery (a draft never
  reads as sent).
- `npm test` fails on: an unapproved send, a hash-mismatched send, an expired
  approval, a replayed webhook event, and a cross-workspace read or write.
- The Context screen lists facts with confirm/reject and deleting a source
  removes it from the mission view.

## Phase 3 — Deployment (target: 1 session; needs dashboard access for keys)

### Tasks
1. `npm install @convex-dev/static-hosting && npx @convex-dev/static-hosting setup`.
2. Deploy Convex functions and the built frontend to a production deployment.
3. Set env vars: `OPENAI_API_KEY` (decide real OpenAI vs DashScope base URL for
   the proof run), `FIRECRAWL_API_KEY`, `FIRECRAWL_WEBHOOK_SECRET`,
   `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`.
4. Register the AgentMail webhook at
   `https://<deployment>.convex.site/agentmail/webhook`.
5. Confirm the Firecrawl webhook route is reachable (or document the poll
   fallback).

### Complete when
- `https://<deployment>.convex.site` loads in a clean browser with no invite or
  login, and a mission can be created from it.
- The webhook endpoint returns 200 for a signed test event and 401 for an
  unsigned one.
- No localhost URL is required anywhere in the running app.
- `hackathon.md` records the live URL and `Frontend: Convex static hosting`.

## Phase 4 — Verification run and evidence (target: 1 session)

### Tasks
1. Run the canonical 12-step proof run from `integration-verification.md` §8
   end-to-end, then run it a second time.
2. Capture evidence per §7: date/environment, mission and run IDs, Convex
   function names, sponsor operations, provider-safe external IDs (job, page,
   message, thread, event, outbound), timestamps, statuses, sanitized
   screenshots.
3. Exercise the failure paths once: replayed webhook, unsigned webhook, expired
   approval attempt.
4. Move the sponsor proof matrix rows to verified with the evidence attached.

### Complete when
- Every row of the sponsor proof matrix has real, reproducible evidence.
- The second run creates zero duplicate messages, outcomes, or source records.
- A replayed webhook and an unsigned webhook cause no state change.
- No artifact contains keys, private message bodies, or personal data.

## Phase 5 — Submission (target: final day, with buffer)

### Tasks
1. Accessibility pass: keyboard-only mission → approval path, visible focus,
   contrast, color never the only status signal, mobile layout.
2. Record the demo video under three minutes following the
   `delivery-proof.md` script.
3. Publish the social post tagging Convex, OpenAI, Firecrawl, and AgentMail.
4. Finalize `hackathon.md`: event, stack, live URL, demo link; no secrets.
5. Complete the `delivery-proof.md` §7 final checklist and test in a clean
   browser.

### Complete when
- A judge can open the public URL, run the representative mission, see sourced
  matches, approve a draft, observe AgentMail delivery and an inbound reply,
  and inspect the persisted outcome (the `faq-and-decisions.md` §18 definition
  of done).
- `hackathon.md` is complete and truthful; the video is under three minutes;
  the social post is live; the final checklist is fully checked.

## Suggested schedule

| Date | Phase |
| --- | --- |
| Sep 15–16 | Phase 1 |
| Sep 17–18 | Phase 2 (Phase 3 can start in parallel once keys are available) |
| Sep 19 | Phase 3 |
| Sep 20 | Phase 4 |
| Sep 21 | Phase 5 + buffer |
| Sep 22 (12:00 PT) | Submit |
