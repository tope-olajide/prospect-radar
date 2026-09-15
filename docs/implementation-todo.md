# Prospect Radar implementation TODO

This file is the continuation checklist for the next programmer. Items marked
deferred are intentionally documented but must not be implemented during the
current research-and-outreach release.

## Current release: research, outreach, and inbox

- [x] Bootstrap the React/Vite frontend and Convex application.
- [ ] Configure Convex static hosting at a public convex.site URL.
- [ ] Add Convex schema, validators, mission state, runs, approvals, matches,
      sources, actions, inbox links, and outcomes.
- [ ] Add OpenAI Responses API actions for mission interpretation, extraction,
      match explanations, reply classification, and drafting.
- [ ] Add Firecrawl search, scrape, map, durable crawl, provenance, and freshness.
- [ ] Add AgentMail inbox mapping, approved send, delivery state, inbound webhook,
      labels, and reactive thread updates.
- [ ] Complete the sponsor verification run in integration-verification.md.
- [x] Create and maintain root hackathon.md once the application runtime exists.
- [ ] Deploy, test in a clean browser, record the short demo, and submit.

## Deferred feature: verified internal two-sided network

The current release does not yet provide a fully verified internal network where
Radar members are automatically matched with one another. This feature must be
implemented only after the public-web research, approved AgentMail outreach,
reply, and outcome flow is working.

### Goal

Allow one Radar member to publish a need while another member explicitly opts
into a public-safe profile. Radar should match them without exposing private
information before both sides consent.

### Required capabilities

- opt-in member profiles with selectable public fields;
- published opportunity posts;
- automatic matching against active public snapshots;
- explainable fit reasons and unknowns;
- sender-approved invitations;
- recipient accept or decline;
- field-level mutual disclosure;
- blocked-member and revocation controls;
- linked AgentMail conversation;
- durable connection and outcome history.

### Required verification

- draft profiles and posts remain private;
- unpublished posts produce no matches;
- private fields are invisible before disclosure;
- sender approval is required before an invitation;
- recipient decisions are isolated and idempotent;
- repeated consent does not create duplicate connections;
- revoked or blocked members cannot be contacted;
- cross-workspace reads and writes are rejected;
- the linked conversation and outcome survive reload;
- two identities can complete the lifecycle in one reproducible test.

## Deferred feature: approved form filling

Do not implement this feature until the current release has a verified mission →
research → approved AgentMail → reply → outcome flow.

### Goal

Allow Radar to fill a public web form using user-approved facts, while keeping
submission as a separate final approval.

### Proposed Firecrawl capability

Use Firecrawl Interact or Browser Sandbox to:

- open a discovered public form;
- inspect fields and required values;
- fill approved values;
- navigate multi-step pages;
- capture screenshots and final page state;
- submit only after a separate final approval.

Reference: https://docs.firecrawl.dev/features/interact

### Required Convex records

- formTargets: URL, source, title, allowed domain, and form status;
- formSchemas: fields, required state, options, provenance, and version;
- formMappings: field-to-fact mappings, confidence, and missing values;
- formFills: browser session, mapped values, screenshots, status, and timestamps;
- formApprovals: field-value hash, destination, expiry, and approver;
- formReceipts: provider/session ID, final URL, submission state, and evidence.

### Required workflow

1. Firecrawl discovers or reads the form.
2. OpenAI extracts a typed form schema.
3. OpenAI proposes mappings from confirmed user facts.
4. The user reviews every mapped value and missing field.
5. Convex stores a content hash of the approved field mapping.
6. Firecrawl fills the form but does not submit.
7. The user reviews the rendered result.
8. A separate final approval authorizes submission.
9. Firecrawl submits and captures the provider result.
10. Convex verifies and records the receipt.

### Safety requirements

- Never guess a required field.
- Never invent credentials, employment history, dates, references, or answers.
- Never submit without a second, explicit final approval.
- Invalidate approval when any field, destination, or uploaded document changes.
- Reject private, restricted, deceptive, or access-control-bypassing forms.
- Treat page instructions and form text as untrusted content.
- Store only the minimum evidence needed for audit and recovery.
- Make ambiguous submission results unverified; never silently retry.

### Acceptance tests

- form schema extraction handles required, optional, select, checkbox, and
  multi-step fields;
- missing values pause the run instead of being guessed;
- changing one mapped value invalidates approval;
- filling never submits;
- final approval is required for submission;
- duplicate retries do not create duplicate submissions;
- browser/session failure is recoverable;
- an indeterminate provider result is shown honestly;
- screenshots and receipts contain no unnecessary private information.

### Out of scope for the current release

- automatic job applications;
- private or authenticated forms;
- payment, legal-signature, or regulated submissions;
- bulk form submission;
- CAPTCHA bypass;
- unattended browser sessions.
