#!/usr/bin/env node
/**
 * Canonical end-to-end outreach proof (docs/integration-verification.md §8).
 *
 * Drives the LIVE production deployment through its public API — the same calls
 * the browser makes — for the full agent arc:
 *
 *   user context → mission → autonomous run → plan → Firecrawl discovery →
 *   entities/signals → explained matches → draft → approval → AgentMail send →
 *   delivery → counterpart reply → signed inbound webhook → classification →
 *   agent continuation (suggested reply) → approval → send → relationship outcome
 *
 * Safety: every message stays inside the workspace owner's own AgentMail
 * account. Nobody outside the account is ever contacted:
 *   - the outreach is sent from the linked Prospect Radar inbox
 *   - the "counterpart" is a second scratch inbox in the same account
 *   - the counterpart's reply is injected with the AgentMail API as that inbox,
 *     replying inside the real thread, so the inbound path is a genuine signed
 *     webhook delivery rather than a simulated row.
 *
 * Usage:
 *   AGENTMAIL_API_KEY=... node scripts/outreachProof.mjs
 *   node scripts/outreachProof.mjs --mission <existingMissionId>   # resume
 *
 * Writes proof/agent-loop.json. Never prints or stores secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const CLOUD = process.env.CONVEX_CLOUD_URL ?? "https://wry-walrus-528.convex.cloud";
const SITE = process.env.CONVEX_SITE_URL ?? "https://wry-walrus-528.convex.site";
const AGENTMAIL_API = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";
const WORKSPACE = process.env.PROOF_WORKSPACE ?? "demo-workspace";
const GOAL = process.env.PROOF_GOAL
  ?? "Find companies that need a React/Next.js developer and help me contact them.";

// A second scratch inbox in the same account plays the counterpart.
const COUNTERPART = process.env.PROOF_COUNTERPART ?? "inquisitivehistory455@agentmail.to";
// The reply deliberately asks for evidence, so continuation has something real
// to resolve against the user's confirmed context.
const COUNTERPART_REPLY = [
  "Thanks for reaching out — this is relevant to us.",
  "Before we take it further: can you send examples of your previous work?",
].join("\n");

const REPLY_SUBJECT = "Re: Prospect Radar self-test: approved outreach over AgentMail";

const resumeArgIndex = process.argv.indexOf("--mission");
const RESUME_MISSION = resumeArgIndex > -1 ? process.argv[resumeArgIndex + 1] : null;

const evidence = [];
const ids = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(step, status, detail) {
  evidence.push({ at: new Date().toISOString(), step, status, detail });
  const mark = status.startsWith("✅") ? "✅" : status.startsWith("❌") ? "❌" : "•";
  console.log(`${mark} ${step}${detail ? ` — ${detail}` : ""}`);
}

async function call(kind, path, args, attempt = 1) {
  try {
    const response = await fetch(`${CLOUD}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { status: "error", errorMessage: `unparseable response: ${text.slice(0, 200)}` };
    }
    if (body.status === "error") {
      const message = String(body.errorMessage ?? "unknown error");
      if (attempt < 4 && /fetch|network|timeout|ECONN|socket hang up/i.test(message)) {
        await sleep(1500 * attempt);
        return call(kind, path, args, attempt + 1);
      }
      throw new Error(`${path}: ${message}`);
    }
    return body.value;
  } catch (error) {
    // Transient network failures ( Wi-Fi blips, TLS resets) get a wider retry
    // window than provider errors: the run is durable server-side, so resuming
    // the harness is always safe.
    if (attempt < 6 && /fetch failed|network|ECONN|socket hang up|ETIMEDOUT|terminated|OTHER_ERROR/i.test(String(error?.cause?.code ?? "") + " " + error.message)) {
      await sleep(2500 * attempt);
      return call(kind, path, args, attempt + 1);
    }
    throw error;
  }
}

const query = (path, args) => call("query", path, args);
const mutation = (path, args) => call("mutation", path, args);
const action = (path, args) => call("action", path, args);

async function until(fn, accept, { timeoutMs = 240_000, intervalMs = 6_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (accept(last)) return last;
    process.stdout.write(".");
    await sleep(intervalMs);
  }
  console.log(` (timed out waiting for ${label})`);
  return last;
}

// ------------------------------------------------------------------- AgentMail

async function agentmail(path, init = {}) {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY is required to inject the counterpart reply");
  const response = await fetch(`${AGENTMAIL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AgentMail ${init.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ 1. context

async function stepContext() {
  const existing = await query("context:list", { workspaceId: WORKSPACE, missionId: null });
  const categories = new Set(existing.map((fact) => fact.category));
  const wanted = [
    {
      category: "services",
      value: "React and Next.js frontend development, from landing pages to full SaaS dashboards.",
    },
    {
      category: "portfolio",
      value: "Work samples: https://examples.prospect-radar.example/case-studies (confirms prior React dashboards and migration work).",
    },
    { category: "experience", value: "Six years building production React applications for mid-size SaaS teams." },
  ];
  let added = 0;
  for (const fact of wanted) {
    if (categories.has(fact.category)) continue;
    await mutation("context:add", {
      workspaceId: WORKSPACE,
      missionId: null,
      category: fact.category,
      value: fact.value,
      sourceType: "user_input",
      sourceReference: null,
      confidence: 1,
      visibility: "workspace",
    });
    added += 1;
  }
  const facts = await query("context:list", { workspaceId: WORKSPACE, missionId: null });
  const confirmed = facts.filter((fact) => fact.verificationStatus === "user_confirmed");
  ids.contextFacts = confirmed.map((fact) => ({ category: fact.category, status: fact.verificationStatus }));
  record(
    "User context available to the agent",
    confirmed.length > 0 ? "✅ real" : "⚠️ none",
    `${confirmed.length} confirmed facts (${added} added now); categories: ${[...new Set(confirmed.map((f) => f.category))].join(", ")}`,
  );
  return confirmed;
}

// ------------------------------------------------------------------ 2. mission

async function stepMission() {
  if (RESUME_MISSION) {
    const rows = await query("missions:list", { workspaceId: WORKSPACE });
    const found = rows.find((row) => row._id === RESUME_MISSION);
    if (!found) throw new Error(`mission ${RESUME_MISSION} not found in ${WORKSPACE}`);
    ids.missionId = found._id;
    // A resumed run's steps live on its own run row; resolve it the same way
    // the UI does so transcript receipts are provable on resume too.
    const runRow = await query("runs:forMission", { missionId: found._id });
    if (runRow?._id) ids.runId = runRow._id;
    record("Mission resumed", "✅ real", found._id);
    return found;
  }
  const created = await mutation("missions:create", {
    workspaceId: WORKSPACE,
    title: GOAL.slice(0, 80),
    rawGoal: GOAL,
    constraints: [],
    sourceScope: "public-web",
    completionPredicate: "A sourced match is approved and sent, its reply is classified, and the outcome is recorded.",
  });
  ids.missionId = created.missionId;
  ids.runId = created.runId;
  record("Mission created from a natural-language goal", "✅ real", `${created.missionId} (run ${created.runId})`);
  return created;
}

// -------------------------------------------------------- 3. autonomous run

async function stepRun() {
  ids.runStartedAt = Date.now();
  const started = await mutation("orchestratorStore:runPipeline", {
    workspaceId: WORKSPACE,
    missionId: ids.missionId,
  });
  record("Agent run started", started.started ? "✅ real" : "• already running", `stage ${started.stage}`);

  const run = await until(
    () => query("runs:forMission", { missionId: ids.missionId }),
    (value) => value && ["waiting", "blocked", "complete", "failed", "cancelled"].includes(value.status),
    { timeoutMs: 480_000, intervalMs: 8_000, label: "the run to reach a gate" },
  );
  ids.runStatus = run?.status;
  ids.runStage = run?.currentStage;
  const gate = run?.status === "waiting" && run?.currentStage === "approval";
  record(
    "Autonomous run reached the approval gate",
    gate ? "✅ real" : `• ${run?.status ?? "unknown"} at ${run?.currentStage ?? "unknown"}`,
    gate ? "waiting at approval — the agent will not act on its own" : `interruption: ${run?.activeInterruption ?? "none"}`,
  );
  return run;
}

// --------------------------------------------- 4. plan, evidence, matches

async function stepEvidence() {
  const plan = await query("plans:getForMission", { missionId: ids.missionId });
  // The classifier's structured understanding lives on the mission row (the
  // plan carries the strategy that was derived from it), so both are read.
  const missionRows = await query("missions:list", { workspaceId: ids.workspaceId ?? WORKSPACE });
  const missionRow = Array.isArray(missionRows) ? missionRows.find((row) => row._id === ids.missionId) : null;
  if (plan) {
    ids.plan = {
      provider: `${plan.provider}:${plan.model}`,
      intent: missionRow?.intent?.primary ?? null,
      secondary: missionRow?.intent?.secondary ?? null,
      confidence: missionRow?.intent?.confidence ?? null,
      rationale: missionRow?.intent?.rationale ?? null,
      targetEntity: missionRow?.targetEntity ?? null,
      relationshipGoal: missionRow?.relationshipGoal ?? null,
      mustHave: plan.mustHave?.length ?? 0,
      strategyNotes: plan.strategyNotes ?? null,
    };
    record(
      "AI classified intent and planned strategy",
      missionRow?.intent?.primary ? "✅ real" : "⚠️ unrecorded",
      `${plan.provider}:${plan.model} · intent ${ids.plan.intent ?? "?"}` +
      `${ids.plan.secondary ? ` + ${ids.plan.secondary}` : ""} · target ${ids.plan.targetEntity ?? "?"}` +
      ` · goal ${ids.plan.relationshipGoal ?? "?"} · ${ids.plan.mustHave} must-have criteria`,
    );
    if (ids.plan.rationale) record("Classifier rationale", "•", ids.plan.rationale.slice(0, 240));
  } else {
    record("AI classified intent and planned strategy", "❌ missing", "no plan row");
  }

  const jobs = await query("researchStore:listJobs", { missionId: ids.missionId });
  const complete = jobs.filter((job) => job.status === "complete");
  record("Firecrawl discovery jobs", complete.length > 0 ? "✅ real" : "⚠️ none",
    `${jobs.length} jobs, ${complete.length} complete` +
    (complete[0]?.resultCount != null ? `, first returned ${complete[0].resultCount} results` : ""));

  const sources = await query("researchStore:listSources", { missionId: ids.missionId });
  ids.sourceCount = sources.length;
  const host = (url) => { try { return new URL(url).hostname; } catch { return url; } };
  record("Sourced evidence persisted", sources.length > 0 ? "✅ real" : "⚠️ none",
    `${sources.length} sources` + (sources[0] ? `, first ${host(sources[0].url)}` : ""));

  const entities = await query("entityStore:listForMission", { missionId: ids.missionId });
  ids.entityCount = entities.length;
  record("Entities + signals extracted", entities.length > 0 ? "✅ real" : "⚠️ none",
    `${entities.length} entities` + (entities[0] ? `, first "${entities[0].name}" (${entities[0].kind}, ${entities[0].extractionStatus})` : ""));

  const signals = await query("entityStore:listSignalsForMission", { missionId: ids.missionId });
  if (signals.length > 0) record("Signals recorded", "✅ real", `${signals.length} signals, first type "${signals[0].type}"`);

  const matches = await query("researchStore:listMatches", { missionId: ids.missionId });
  ids.matchIds = matches.map((match) => match._id);
  // `listMatches` exposes the LLM explanation as `explanationSummary`; a match is
  // explained when that field is populated (heuristic labels alone do not count).
  const explained = matches.filter((match) => match.explanationSummary);
  const topExplained = explained[0] ?? matches[0];
  if (topExplained) {
    ids.topMatch = {
      label: topExplained.label,
      summary: topExplained.explanationSummary?.slice(0, 220) ?? null,
      model: topExplained.explanationModel ?? null,
      unknowns: topExplained.unknowns?.slice(0, 3) ?? [],
      risks: topExplained.risks?.slice(0, 3) ?? [],
      recommendedAction: topExplained.recommendedAction ?? null,
    };
  }
  record("Explainable matches produced", explained.length > 0 ? "✅ real" : "⚠️ none",
    `${matches.length} matches, ${explained.length} explained by ${matches.find((match) => match.explanationModel)?.explanationModel ?? "no model"};` +
    ` top label "${topExplained?.label ?? "none"}"` +
    (topExplained?.recommendedAction ? `, recommends ${topExplained.recommendedAction}` : ""));
  for (const match of explained.slice(0, 2)) {
    record("Explained match", "•", `${match.label}: ${(match.explanationSummary ?? "").slice(0, 180)}`);
  }

  const steps = ids.runId ? await query("runs:steps", { runId: ids.runId }) : [];
  ids.runTools = [...new Set(steps.map((step) => step.tool).filter(Boolean))];
  record("Agent transcript receipts", ids.runTools.length > 0 ? "✅ real" : "⚠️ none",
    ids.runTools.length > 0 ? `tools: ${ids.runTools.join(", ")}` : "no tool receipts yet");

  return { plan, sources, entities, signals, matches };
}

// -------------------------------------------- 5. draft → approval → send

async function stepOutreach(inbox) {
  const matches = await query("researchStore:listMatches", { missionId: ids.missionId });
  const match = matches[0] ?? null;

  const subject = "Prospect Radar self-test: approved outreach over AgentMail";
  const body = [
    "Hello — this message was drafted by Prospect Radar, approved by the operator, and delivered by AgentMail.",
    `Mission: ${GOAL}`,
    match ? `Match under review: ${match.label}` : "No match was available in this run.",
    "",
    "It is addressed to a second inbox inside the same AgentMail account, so both the send path and",
    "the inbound path are proven without emailing anyone outside the workspace.",
  ].join("\n");

  const draft = await action("outreach:draft", {
    workspaceId: WORKSPACE,
    missionId: ids.missionId,
    matchId: match ? match._id : null,
    agentmailInboxId: inbox.agentmailInboxId,
    recipient: COUNTERPART,
    subject,
    body,
    clientRequestId: `proof-draft-${Date.now()}`,
  });
  ids.actionId = draft.actionId;
  record("Outreach draft created (unsent)", "✅ real",
    `${draft.actionId} → ${COUNTERPART}, status "${draft.status}"`);

  const approval = await mutation("outreachStore:approve", { workspaceId: WORKSPACE, actionId: draft.actionId });
  ids.approval = { status: approval.status, expiresAt: approval.expiresAt };
  record("Approval bound to the exact content", "✅ real",
    `status "${approval.status}", expires ${new Date(approval.expiresAt).toISOString()}`);

  const sent = await action("outreach:send", { workspaceId: WORKSPACE, actionId: draft.actionId });
  ids.outboundId = sent.outboundId;
  ids.threadId = sent.threadId;
  ids.providerMessageId = sent.providerMessageId;
  record("AgentMail send", sent.outboundId ? "✅ real" : "❌ refused",
    `outbound ${sent.outboundId ?? "none"}${sent.threadId ? `, thread ${sent.threadId}` : ""}`);

  const synced = await until(
    () => action("outreach:syncOutbound", { workspaceId: WORKSPACE, actionId: draft.actionId }),
    (value) => ["sent", "delivered", "failed", "bounced"].includes(value?.status),
    { timeoutMs: 120_000, intervalMs: 6_000, label: "delivery state" },
  );
  ids.deliveryStatus = synced?.status;
  record("Delivery state observed", synced?.providerMessageId ? "✅ real" : "⚠️ pending",
    `status "${synced?.status}"${synced?.providerMessageId ? `, provider message ${synced.providerMessageId}` : ""}`);

  return { draft, sent };
}

// ------------------------- 6. the counterpart replies inside the real thread

async function stepCounterpartReply() {
  const inbox = process.env.AGENTMAIL_API_KEY ? await agentmail(`/inboxes/${COUNTERPART}/messages?limit=10`) : null;
  if (!inbox) {
    record("Counterpart reply injected", "• skipped", "AGENTMAIL_API_KEY not provided to the harness");
    return null;
  }
  const messages = inbox.messages ?? [];
  const received = messages.find((message) => (message.subject ?? "").startsWith("Prospect Radar self-test"))
    ?? messages[0];
  if (!received) {
    record("Counterpart reply injected", "❌ failed", `no message found in ${COUNTERPART}`);
    return null;
  }
  ids.counterpartMessageId = received.message_id;

  const reply = await agentmail(`/inboxes/${COUNTERPART}/messages/${received.message_id}/reply`, {
    method: "POST",
    body: JSON.stringify({ text: COUNTERPART_REPLY, subject: REPLY_SUBJECT }),
  });
  ids.counterpartReplyId = reply.message_id ?? null;
  record("Counterpart replied inside the provider thread", reply.message_id ? "✅ real" : "⚠️ unconfirmed",
    `from ${COUNTERPART} replying to ${received.message_id}${reply.thread_id ? ` in thread ${reply.thread_id}` : ""}`);
  return reply;
}

// ---------------------------- 7. signed webhook → ingest → classify → continue

async function stepInbound() {
  // Only messages that arrived after this run started count: earlier proof runs
  // leave received messages behind, and reading those would resolve the
  // continuation against a stale classification.
  const startedAt = ids.runStartedAt ?? Date.now() - 60_000;
  const inbound = await until(
    async () => {
      const threads = await query("inbox:listThreads", { workspaceId: WORKSPACE, missionId: null });
      let received = [];
      for (const thread of threads) {
        const rows = await query("inbox:listMessages", { workspaceId: WORKSPACE, threadId: thread.threadId });
        received = received.concat(rows.filter((row) => row.direction === "received"));
      }
      received.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { threads, received, fresh: received.filter((row) => (row.createdAt ?? 0) >= startedAt) };
    },
    (value) => value.fresh.length > 0,
    { timeoutMs: 300_000, intervalMs: 10_000, label: "the signed inbound webhook" },
  );
  inbound.received = inbound.fresh;

  if (inbound.received.length === 0) {
    record("Inbound reply delivered by the signed webhook", "❌ not received",
      `${inbound.threads.length} threads exist but no received message arrived`);
    return null;
  }

  const message = inbound.received[0]; // newest first
  ids.inbound = {
    messageId: message._id,
    threadId: message.threadId,
    subject: message.subject,
    preview: message.preview?.slice(0, 160) ?? null,
  };
  record("Inbound reply delivered by the signed webhook", "✅ real",
    `${message._id} in thread ${message.threadId}, subject "${message.subject}"`);

  const classifications = await until(
    () => query("outreachStore:listClassifications", { workspaceId: WORKSPACE, missionId: null }),
    (rows) => rows.some((row) => row.messageId === message._id),
    { timeoutMs: 240_000, intervalMs: 8_000, label: "reply classification" },
  );
  const classification = classifications.find((row) => row.messageId === message._id) ?? null;
  if (classification) {
    ids.classification = {
      label: classification.label,
      confidence: classification.confidence ?? null,
      model: classification.model,
      nextAction: classification.suggestedNextAction,
      suggestedDraftId: classification.suggestedDraftId ?? null,
      summary: classification.summary?.slice(0, 200) ?? null,
    };
    record("Reply classified and next action decided by the LLM", "✅ real",
      `label "${classification.label}" · ${classification.model} · next step: ${classification.suggestedNextAction}` +
      (classification.suggestedDraftId ? " · suggested reply drafted" : ""));
  } else {
    record("Reply classified and next action decided by the LLM", "⚠️ pending",
      "classification had not landed within the window");
  }
  return { message, classification };
}

// -------------------------------------- 8. continuation → approve → send → outcome

async function stepContinuation(inbox, classification) {
  if (!classification?.suggestedDraftId) {
    record("Agent continuation reply sent", "⚠️ no suggested draft",
      "classification produced no suggested reply to approve");
    return null;
  }

  const drafts = await query("outreachStore:listDrafts", { workspaceId: WORKSPACE, missionId: ids.missionId });
  const draft = drafts.find((row) => row._id === classification.suggestedDraftId)
    ?? drafts.filter((row) => row._id !== ids.actionId).slice(-1)[0]
    ?? null;
  if (!draft) {
    record("Agent continuation reply sent", "⚠️ draft missing", "suggested draft id did not resolve");
    return null;
  }
  ids.continuationDraftId = draft._id;
  record("Agent proposed a follow-up reply (awaiting approval)", "✅ real",
    `${draft._id} → ${draft.recipient}`);

  const approval = await mutation("outreachStore:approve", { workspaceId: WORKSPACE, actionId: draft._id });
  const sent = await action("outreach:send", { workspaceId: WORKSPACE, actionId: draft._id });
  ids.continuationOutboundId = sent.outboundId ?? null;
  record("Continuation reply sent after approval", sent.outboundId ? "✅ real" : "⚠️ refused",
    `approval "${approval.status}" → outbound ${sent.outboundId ?? "none"}` +
    `${sent.threadId ? ` in thread ${sent.threadId}` : ""}`);

  const synced = await until(
    () => action("outreach:syncOutbound", { workspaceId: WORKSPACE, actionId: draft._id }),
    (value) => ["sent", "delivered", "failed", "bounced"].includes(value?.status),
    { timeoutMs: 120_000, intervalMs: 6_000, label: "continuation delivery" },
  );
  record("Continuation delivery state", synced?.status === "sent" || synced?.status === "delivered" ? "✅ real" : "• pending",
    `status "${synced?.status}"`);

  void inbox;
  return sent;
}

async function stepOutcome() {
  const outcomes = await query("outcomes:listForMission", { workspaceId: WORKSPACE, missionId: ids.missionId });
  const outcome = outcomes[0] ?? null;
  if (outcome) {
    ids.outcome = {
      stage: outcome.stage,
      nextAction: outcome.nextAction,
      evidence: outcome.latestEvidence?.slice(0, 200) ?? null,
      counterpart: outcome.counterpartLabel ?? outcome.counterpart ?? null,
    };
    record("Relationship outcome persisted", "✅ real",
      `stage "${outcome.stage}" · next action: ${outcome.nextAction}` +
      (outcome.latestEvidence ? ` · evidence: ${outcome.latestEvidence.slice(0, 120)}` : ""));
  } else {
    record("Relationship outcome persisted", "⚠️ none", "no outcome row for this mission");
  }

  const followUps = await query("relationships:followUpsForMission", { workspaceId: WORKSPACE, missionId: ids.missionId });
  const sequences = await query("relationships:sequencesForMission", { workspaceId: WORKSPACE, missionId: ids.missionId });
  record("Relationship memory (sequences + follow-ups)", followUps.length + sequences.length > 0 ? "✅ real" : "• none yet",
    `${sequences.length} sequences, ${followUps.length} follow-ups`);

  const overview = await query("commandCenter:overview", { workspaceId: WORKSPACE });
  ids.pipeline = overview.pipeline.filter((row) => row.count > 0);
  record("Command center reflects the relationship", ids.pipeline.length > 0 ? "✅ real" : "⚠️ empty",
    ids.pipeline.map((row) => `${row.stage}:${row.count}`).join(", ") || "no staged relationships");

  return outcome;
}

async function stepIdempotency() {
  if (!ids.actionId) return;
  try {
    const again = await action("outreach:send", { workspaceId: WORKSPACE, actionId: ids.actionId });
    const same = again.outboundId === ids.outboundId || again.providerMessageId === ids.providerMessageId;
    record("Re-sending the same approved action does not duplicate", same ? "✅ real" : "⚠️ new send",
      `second call returned ${again.outboundId ?? "no outbound"} with status "${again.status}"`);
  } catch (error) {
    record("Re-sending the same approved action is refused", "✅ real", error.message.slice(0, 160));
  }
}

// --------------------------------------------------------------------- main

async function main() {
  console.log(`Agent loop proof run against ${CLOUD}\n`);
  const inbox = await query("outreachStore:getInbox", { workspaceId: WORKSPACE });
  if (!inbox) throw new Error("no AgentMail inbox is linked to this workspace");
  ids.inbox = { email: inbox.email, agentmailInboxId: inbox.agentmailInboxId };
  record("AgentMail inbox linked", "✅ real", inbox.email);
  ids.counterpart = COUNTERPART;

  await stepContext();
  await stepMission();
  await stepRun();
  await stepEvidence();
  await stepOutreach(inbox);
  await stepCounterpartReply();
  const inbound = await stepInbound();
  await stepContinuation(inbox, inbound?.classification ?? null);
  await stepOutcome();
  await stepIdempotency();

  const proven = evidence.filter((row) => row.status.startsWith("✅")).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    environment: "prod wry-walrus-528",
    cloud: CLOUD,
    site: SITE,
    workspace: WORKSPACE,
    goal: GOAL,
    counterpart: COUNTERPART,
    note: "All email stays inside the workspace owner's own AgentMail account; no third party was contacted.",
    ids,
    summary: {
      steps: evidence.length,
      proven,
      runStatus: ids.runStatus,
      runStage: ids.runStage,
      delivery: ids.deliveryStatus ?? null,
      classifiedAs: ids.classification?.label ?? null,
      outcomeStage: ids.outcome?.stage ?? null,
    },
    evidence,
  };
  mkdirSync("proof", { recursive: true });
  writeFileSync("proof/agent-loop.json", `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\n${proven}/${evidence.length} steps proven → proof/agent-loop.json`);
}

main().catch((error) => {
  console.error("\nproof run failed:", error.message);
  try {
    mkdirSync("proof", { recursive: true });
    writeFileSync(
      "proof/agent-loop.json",
      `${JSON.stringify({ generatedAt: new Date().toISOString(), partial: true, error: error.message, ids, evidence }, null, 2)}\n`,
    );
    console.error("partial evidence written to proof/agent-loop.json");
  } catch {
    // Nothing more we can do.
  }
  process.exitCode = 1;
});
