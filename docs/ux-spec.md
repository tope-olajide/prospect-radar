# User experience specification

## 1. Experience goal

Radar should feel like a trusted operator beside the user: proactive,
source-aware, and quiet until a decision matters. The primary interaction is a
mission composer supported by compact controls for confirmation, filtering, and
approval.

## 2. Application shell

Desktop:

- left rail: Radar, active mission, Home, Discover, Inbox, Outcomes, Context, Network, Settings;
- top bar: mission status, crawl progress, unread replies, and account menu;
- main canvas: current workspace;
- right drawer: evidence, run activity, or approval detail.

Mobile:

- compact header with mission status;
- bottom navigation for Home, Discover, Inbox, and Outcomes;
- drawers become full-screen sheets;
- approval actions remain visible without horizontal scrolling.

## 3. Screens

### Home / Mission brief

Shows the active mission, current run state, top matches, source freshness,
pending approval, unread inbox activity, and the next recommended action.

### Mission setup

Contains the command composer, mode suggestion, missing high-impact questions,
source-scope controls, and completion predicate preview.

### Discover

Shows ranked match cards with:

- match label, not fake numerical certainty;
- source links and dates;
- positive evidence;
- unknowns and risks;
- freshness;
- research, save, draft, and dismiss actions.

### Match detail

Uses progressive disclosure:

1. plain-language summary;
2. why it fits;
3. source evidence;
4. what is unknown;
5. suggested next action;
6. activity and related inbox thread.

### AgentMail Inbox

Shows labels, threads, delivery state, sender, subject, linked mission, and
latest outcome. New inbound mail appears through the Convex subscription.

### Thread detail

Displays the complete conversation, source-aware draft suggestions, approval
status, delivery receipt, and a clear boundary between generated draft and sent
message.

### Activity

Shows durable run stages, source calls, crawl progress, OpenAI decisions,
interruptions, approvals, retries, and receipts. It must never simulate progress
with a timer.

### Outcomes

Shows the relationship history after a run pauses or finishes: counterpart,
latest evidence, conversation, next action, status, and timeline.

### Context

Shows confirmed facts, public source records, user edits, visibility, freshness,
and deletion controls.

### Network

Provides the deferred opt-in profile, opportunity post, match, invitation,
disclosure, and connection concepts. It is not part of the current release.

## 4. Interaction states

Every async surface supports:

- loading;
- empty;
- partial;
- stale;
- waiting for approval;
- waiting for connection or permission;
- retryable failure;
- blocked with an explanation;
- complete with evidence.

Every external result shows its source and whether it is real, cached, inferred,
or simulated.

## 5. Approval card

An approval card must show:

- recipient and destination;
- exact subject and body;
- context and facts used;
- assumptions;
- side effects;
- expiry;
- content hash or “changed since draft” warning;
- approve, edit, reject, and keep-draft actions.

Editing invalidates the previous approval.

## 6. Accessibility and copy

- keyboard navigation for every primary action;
- visible focus states;
- semantic headings and landmarks;
- color is never the only status signal;
- source links are descriptive;
- generated copy uses specific, respectful language;
- the UI says “drafted,” “sent,” “delivered,” or “unverified,” never “contacted” when only a draft exists.

## 7. Demo acceptance

The three-minute demo should visibly show:

1. a natural-language mission;
2. live source-backed matches;
3. one evidence panel;
4. an approval boundary;
5. AgentMail delivery state;
6. an inbound reply appearing in the inbox;
7. an outcome and next action.
