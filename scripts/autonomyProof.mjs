#!/usr/bin/env node
/**
 * Live autonomy proof — the real deployment, driven by the persisted stage
 * machine, with the harness acting only as the *user*.
 *
 * The claim this script exists to test is the product claim:
 *
 *   a user states a goal, leaves, and Radar carries the mission by itself,
 *   surfacing only for information, conflicts, or a consequential approval.
 *
 * So the harness is deliberately allowed to do only what a person does:
 *   1. provide context facts / material (that is the user telling Radar about
 *      themselves)
 *   2. create the mission and start it            ("Run Radar")
 *   3. approve the plan                           (the plan gate)
 *   4. approve one exact draft                    (the action gate)
 *   5. reply as the counterpart                   (the external world)
 *
 * Everything between those — intake, interpret, context_check, plan, discover,
 * investigate, evaluate, decide, propose, execute, observe, continue, complete —
 * must advance on the deployed scheduler and the deployed webhook. The script
 * records every call it makes so a reader can check that no intermediate stage
 * was pushed from outside, and it records the persisted rows (run, events,
 * steps, plan, decisions, matches, drafts, inbox, outcomes, budget) that prove
 * what actually happened, rather than screenshots.
 *
 * Safety: the counterpart is a scratch inbox inside the account owner's own
 * AgentMail account, and the page the mission discovers (proof/test-partner) is
 * a fixture that lists that address. Nobody outside the account is contacted.
 *
 * Usage:
 *   AGENTMAIL_API_KEY=… node scripts/autonomyProof.mjs --scenario a
 *   node scripts/autonomyProof.mjs --scenario d --fresh       # new user, no inbox
 *   node scripts/autonomyProof.mjs --scenario a --mission <id>  # resume watching
 *
 * Evidence is written to proof/autonomy/<scenario>.json. Secrets are never
 * printed or stored.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CLOUD = process.env.CONVEX_CLOUD_URL ?? "https://wry-walrus-528.convex.cloud";
const AGENTMAIL_API = process.env.AGENTMAIL_BASE_URL ?? "https://api.agentmail.to/v0";
const WORKSPACE = process.env.PROOF_WORKSPACE ?? "demo-workspace";
const COUNTERPART = process.env.PROOF_COUNTERPART ?? "inquisitivehistory455@agentmail.to";
const PARTNER_PAGE = "https://raw.githubusercontent.com/tope-olajide/prospect-radar/main/proof/test-partner/index.html";
const POLL_MS = 5000;
const DEADLINE_MS = Number(process.env.PROOF_DEADLINE_MS ?? 9 * 60 * 1000);

// ── args ──────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const SCENARIO = arg("scenario") ?? "a";
const FRESH = process.argv.includes("--fresh");
const RESUME = arg("mission");
// The user pressing "Retry" on a blocked run is a user act, not a workflow
// step, so it is opt-in and recorded like the other gates.
let RETRIES_ALLOWED = Number(arg("retries") ?? (process.argv.includes("--retry") ? 3 : 0));

// ── scenarios ─────────────────────────────────────────────────────────
const SCENARIOS = {
  a: {
    label: "A — contact mission with a reachable email route",
    goal: `Find a small clinic group that runs several sites and could use multi-location scheduling software, then get in touch with them. I know they publish a partner page here: ${PARTNER_PAGE}`,
    facts: [
      ["product", "I build multi-location scheduling and patient-intake software for clinic groups (rosters, recurring appointments, reminders)."],
      ["target_customer", "Clinic groups running three to eight sites that still coordinate appointments by phone or spreadsheet."],
      ["location", "United Kingdom, remote delivery."],
    ],
    counterpart: COUNTERPART,
    reply: "Thanks for reaching out — this is relevant. Can you send examples of previous deployments?",
  },
  b: {
    label: "B — contact mission where no supported route can be established",
    goal:
      "Find independent coffee roasters in Portugal that publish a contact page, and tell me who is worth talking to about wholesale scheduling.",
    facts: [
      ["product", "I build operations software for food producers: order intake, production scheduling, delivery planning."],
      ["target_customer", "Small independent roasters with a wholesale customer list."],
      ["location", "Portugal."],
    ],
  },
  c: {
    label: "C — target reachable only through a route Radar cannot use",
    goal:
      "Find recruiters who place operations staff at UK logistics firms, and contact them.",
    facts: [
      ["product", "I build warehouse operations software."],
      ["target_customer", "UK logistics firms with 50-200 staff."],
      ["location", "United Kingdom."],
    ],
  },
  d: {
    label: "D — finding-oriented objective (a solution, not a contact)",
    goal:
      "Find a scheduling solution for a six-site outpatient clinic group that needs multi-location rosters, recurring appointments and reminders.",
    facts: [
      ["problem", "A six-site clinic group coordinates 1,900 appointments a week by phone and a spreadsheet; they need multi-location scheduling with recurring appointments and reminders."],
      ["constraints", "Must handle six sites and per-practitioner availability; small budget; no full IT team."],
    ],
  },
  e: {
    label: "E — source-backed material, authorization, and a withdrawn authorization",
    goal: `Find a small clinic group that needs multi-location scheduling software and get in touch with them. Their partner page: ${PARTNER_PAGE}`,
    facts: [
      ["product", "I build multi-location scheduling and patient-intake software for clinic groups."],
      ["target_customer", "Clinic groups running three to eight sites."],
    ],
    counterpart: COUNTERPART,
    reply: "Thanks — could you send the case study you mentioned?",
    withdrawAfterApproval: true,
  },
};
const scenario = SCENARIOS[SCENARIO];
if (!scenario) {
  console.error(`Unknown scenario "${SCENARIO}". Use one of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

// ── evidence ──────────────────────────────────────────────────────────
const evidence = {
  capturedAt: new Date().toISOString(),
  scenario: SCENARIO,
  label: scenario.label,
  convexUrl: CLOUD,
  freshUser: FRESH,
  goal: scenario.goal,
  /** Every mutation this harness makes, so "no stage was driven" is checkable. */
  harnessCalls: [],
  timeline: [],
  gates: [],
  autonomousTransitions: [],
  errors: [],
  final: {},
};
const redact = (value) => JSON.stringify(value ?? null).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted]");
const at = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_PATH = `proof/autonomy/${SCENARIO}.json`;
/** Every run keeps its own file, so a later run cannot erase an earlier finding. */
const EVIDENCE_RUN_PATH = `proof/autonomy/${SCENARIO}-${RUN_STAMP}.json`;
/**
 * Evidence is written as the run progresses, not only at the end.
 *
 * A live mission can take longer than the shell waiting on it, and a killed
 * harness used to take the whole record with it — including the ids needed to
 * resume watching a mission that is still running server-side.
 */
function writeEvidence() {
  evidence.updatedAt = at();
  mkdirSync("proof/autonomy", { recursive: true });
  const json = JSON.stringify(evidence, null, 2);
  writeFileSync(EVIDENCE_RUN_PATH, json);
  writeFileSync(EVIDENCE_PATH, json);
}

function record(kind, detail) {
  evidence.timeline.push({ at: at(), kind, detail });
  console.log(`  ${kind}: ${typeof detail === "string" ? detail : redact(detail)}`);
  writeEvidence();
}

// ── clients ───────────────────────────────────────────────────────────
const cloud = new ConvexHttpClient(CLOUD);
let workspaceId = WORKSPACE;

async function harnessMutation(name, fn) {
  evidence.harnessCalls.push({ at: at(), kind: "mutation", name });
  return fn();
}
async function harnessQuery(name, fn) {
  evidence.harnessCalls.push({ at: at(), kind: "query", name });
  return fn();
}

async function agentmail(path, init = {}) {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY is required to inject the counterpart reply");
  const response = await fetch(`${AGENTMAIL_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AgentMail ${init.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ── snapshot: what is actually persisted ──────────────────────────────
async function snapshot(missionId) {
  const run = await cloud.query(api.runs.forMission, { missionId });
  const [plan, events, steps, jobs, sources, matches, entities, decisions, drafts, budget] = await Promise.all([
    cloud.query(api.plans.getForMission, { missionId }),
    run ? cloud.query(api.runs.events, { runId: run._id }) : [],
    run ? cloud.query(api.runs.steps, { runId: run._id }) : [],
    cloud.query(api.researchStore.listJobs, { missionId }),
    cloud.query(api.researchStore.listSources, { missionId }),
    cloud.query(api.researchStore.listMatches, { missionId }),
    cloud.query(api.entityStore.listForMission, { missionId }),
    cloud.query(api.actionStore.decisions, { workspaceId, missionId }),
    cloud.query(api.outreachStore.listDrafts, { workspaceId, missionId }),
    cloud.query(api.budget.status, { workspaceId, missionId }),
  ]);
  return { run, plan, events, steps, jobs, sources, matches, entities, decisions, drafts, budget };
}

/** Waits until the run reaches a state, recording every distinct transition. */
async function watchUntil(missionId, predicate, { label, timeoutMs = DEADLINE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  while (Date.now() < deadline) {
    const snap = await snapshot(missionId);
    const run = snap.run;
    if (run) {
      const key = `${run.status}:${run.currentStage}`;
      if (key !== lastKey) {
        lastKey = key;
        const row = { at: at(), status: run.status, stage: run.currentStage, interruption: run.activeInterruption ?? null };
        evidence.autonomousTransitions.push(row);
        console.log(`   · ${run.currentStage} / ${run.status}${run.activeInterruption ? ` (${run.activeInterruption})` : ""}`);
        writeEvidence();
      }
      if (predicate(snap, run)) return snap;
    }
    await sleep(POLL_MS);
  }
  record("timeout", `waited ${Math.round(timeoutMs / 1000)}s for ${label}`);
  return snapshot(missionId);
}

// ── user-side setup ───────────────────────────────────────────────────
async function signUpFresh() {
  const email = `radar-autonomy-${Date.now()}@example.com`;
  const password = `Rdr!${Math.random().toString(36).slice(2)}${Date.now()}`;
  const signedIn = await cloud.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  const token = signedIn?.tokens?.token;
  if (!token) throw new Error("sign-up returned no token");
  cloud.setAuth(token);
  const provisioned = await harnessMutation("users.provisionWorkspace", () => cloud.mutation(api.users.provisionWorkspace, {}));
  workspaceId = provisioned.workspaceId;
  record("user", `signed up and provisioned workspace ${String(workspaceId).slice(0, 8)}…`);
  evidence.workspaceId = String(workspaceId);
}

async function ensureContext() {
  const existing = await harnessQuery("context.list", () => cloud.query(api.context.list, { workspaceId, missionId: null }));
  const have = new Set(existing.filter((f) => ["user_confirmed", "user_corrected"].includes(f.verificationStatus)).map((f) => f.category));
  for (const [category, value] of scenario.facts) {
    if (have.has(category)) continue;
    await harnessMutation("context.add", () =>
      cloud.mutation(api.context.add, {
        workspaceId,
        missionId: null,
        category,
        value,
        sourceType: "user_input",
        sourceReference: null,
        confidence: 1,
        visibility: "workspace",
      }),
    );
    const added = await harnessQuery("context.list", () => cloud.query(api.context.list, { workspaceId, missionId: null }));
    const fact = added.find((f) => f.category === category && f.value === value);
    if (fact && fact.verificationStatus !== "user_confirmed") {
      await harnessMutation("context.confirm", () => cloud.mutation(api.context.confirm, { workspaceId, factId: fact._id }));
    }
    record("context", `${category} confirmed by the user`);
  }
}

/** Scenario E's material: a document Radar may read, and separately may attach. */
async function ensureArtifact() {
  const sources = await harnessQuery("dataSources.list", () => cloud.query(api.dataSources.list, { workspaceId }));
  let source = sources.find((row) => row.title === "Clinic deployments case study");
  if (!source) {
    const sourceId = await harnessMutation("dataSources.addSnippet", () =>
      cloud.mutation(api.dataSources.addSnippet, {
        workspaceId,
        title: "Clinic deployments case study",
        text: "Case study: multi-location scheduling rollout for a six-site clinic group. Deployed rosters, recurring appointments and SMS reminders across all six sites. Five years of scheduling-software deployments in outpatient care.",
      }),
    );
    await harnessMutation("dataSources.setRepresentationAllowed", () =>
      cloud.mutation(api.dataSources.setRepresentationAllowed, { workspaceId, sourceId, allowed: true }),
    );
    record("artifact", "added a case study the user authorized Radar to attach");
    source = { _id: sourceId };
  } else if (!source.representationAllowed) {
    await harnessMutation("dataSources.setRepresentationAllowed", () =>
      cloud.mutation(api.dataSources.setRepresentationAllowed, { workspaceId, sourceId: source._id, allowed: true }),
    );
  }
  return source._id;
}

// ── the mission loop ──────────────────────────────────────────────────
async function runMission(missionId) {
  const gateDeadline = Date.now() + DEADLINE_MS;
  let approvedPlan = false;
  let approvedDraftId = null;
  let withdrew = false;

  while (Date.now() < gateDeadline) {
    const snap = await watchUntil(
      missionId,
      // Stop on a gate *or* on a terminal state: a finished mission must end the
      // watch immediately, not sit until the deadline waiting for a gate that
      // will never come.
      (s, run) =>
        ["complete", "failed", "cancelled"].includes(run.status)
        || (run.status === "waiting" && ["plan_review", "approval", "context_check", "intake"].includes(run.currentStage)),
      { label: "a gate or completion" },
    );
    const run = snap.run;
    if (!run) continue;
    if (["complete", "failed", "cancelled"].includes(run.status)) return snap;

    // ── the plan gate: the user's decision to spend anything ──
    if (run.status === "waiting" && run.currentStage === "plan_review") {
      if (approvedPlan) {
        evidence.errors.push({ kind: "plan_gate_reopened", at: at() });
        return snap;
      }
      approvedPlan = true;
      evidence.gates.push({
        gate: "plan_review",
        at: at(),
        objective: snap.plan ? { successKind: snap.plan.successKind ?? null, targetCount: snap.plan.targetCount ?? null } : null,
        normalizedGoal: snap.plan?.normalizedGoal ?? null,
        model: snap.plan?.model ?? null,
      });
      console.log(`  gate · plan review → approving (objective: ${snap.plan?.successKind ?? "inherited from intent"}${snap.plan?.targetCount ? ` ×${snap.plan.targetCount}` : ""})`);
      await harnessMutation("orchestratorStore.approvePlan", () => cloud.mutation(api.orchestratorStore.approvePlan, { workspaceId, missionId }));
      continue;
    }

    // ── the action gate: approving one exact proposal ──
    if (run.status === "waiting" && run.currentStage === "approval") {
      const pending = snap.drafts.filter((draft) => ["draft", "awaiting_approval"].includes(draft.status));
      const decision = snap.decisions.at(-1) ?? null;
      evidence.gates.push({
        gate: "approval",
        at: at(),
        drafts: snap.drafts.length,
        pending: pending.length,
        decision: decision && {
          decision: decision.decision,
          actionability: decision.actionability,
          reason: decision.reason,
          quality: decision.quality,
          capability: decision.capability,
          detail: decision.detail,
          usedFacts: decision.usedFacts,
          artifacts: decision.artifacts,
          alternatives: decision.alternatives,
        },
      });
      if (pending.length === 0) {
        console.log(`  gate · approval with nothing to approve yet (${decision?.reason ?? "no decision recorded"}) — watching for the agent to propose`);
        // The agent proposes on its own pass; keep polling rather than acting.
        const proposed = await watchUntil(missionId, (s) => s.drafts.some((d) => ["draft", "awaiting_approval"].includes(d.status)), {
          label: "a proposed draft",
          timeoutMs: 4 * 60 * 1000,
        });
        if (!proposed.drafts.some((d) => ["draft", "awaiting_approval"].includes(d.status))) {
          evidence.errors.push({ kind: "no_proposal", decision });
          return proposed;
        }
        continue;
      }
      const draft = pending[0];
      if (approvedDraftId === draft._id) {
        evidence.errors.push({ kind: "approval_gate_reopened", draftId: draft._id });
        return snap;
      }
      approvedDraftId = draft._id;
      console.log(`  gate · approval → approving "${draft.subject}" to [redacted]${draft.attachments.length ? ` with ${draft.attachments.length} attachment(s)` : ""}`);
      await harnessMutation("outreachStore.approve", () => cloud.mutation(api.outreachStore.approve, { workspaceId, actionId: draft._id }));

      // Scenario E: withdraw the authorization *after* approval. The send must
      // then fail closed rather than quietly sending less than was approved.
      if (scenario.withdrawAfterApproval && !withdrew) {
        withdrew = true;
        const attachments = draft.attachments ?? [];
        for (const attachment of attachments) {
          await harnessMutation("dataSources.setRepresentationAllowed", () =>
            cloud.mutation(api.dataSources.setRepresentationAllowed, { workspaceId, sourceId: attachment.sourceId, allowed: false }),
          );
        }
        record("withdrew authorization", `${attachments.length} attachment(s) no longer authorized`);
      }
      continue;
    }

    // ── an information gate: the agent asking for something it cannot invent ──
    if (run.status === "waiting" && run.currentStage === "context_check") {
      evidence.gates.push({ gate: "context_check", at: at(), asking: true });
      record("context_check", "the agent stopped for information instead of inventing it");
      return snap;
    }
    if (run.status === "waiting" && run.currentStage === "intake") {
      evidence.gates.push({ gate: "clarification", at: at() });
      record("clarification", "the classifier asked the user what they meant");
      return snap;
    }
    if (run.status === "blocked") {
      const lastStep = snap.steps.at(-1) ?? null;
      evidence.errors.push({ kind: "blocked", stage: run.currentStage, interruption: run.activeInterruption, lastStep });
      if (RETRIES_ALLOWED > 0) {
        RETRIES_ALLOWED -= 1;
        evidence.gates.push({ gate: "retry", at: at(), stage: run.currentStage, interruption: run.activeInterruption });
        console.log(`  gate · retry → resuming ${run.currentStage} after ${run.activeInterruption}`);
        await harnessMutation("orchestratorStore.retryStage", () => cloud.mutation(api.orchestratorStore.retryStage, { workspaceId, missionId }));
        continue;
      }
      return snap;
    }
  }
  return snapshot(missionId);
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nLive autonomy proof — scenario ${SCENARIO}: ${scenario.label}`);
  console.log(`deployment: ${CLOUD}`);
  console.log(`workspace:  ${FRESH ? "(new user)" : WORKSPACE}\n`);

  // The inbox is what makes email a capability. Waiting until provisioning is
  // possible is the user's job, not the agent's, so it is done first.
  if (FRESH) await signUpFresh();
  else evidence.workspaceId = workspaceId;

  const inbox = await cloud.query(api.outreachStore.getInbox, { workspaceId }).catch(() => null);
  evidence.sendingInbox = inbox ? "linked" : "none";
  console.log(`  sending inbox: ${inbox ? "linked" : "none (email is not an available capability here)"}\n`);

  await ensureContext();
  if (SCENARIO === "e") evidence.artifactSourceId = await ensureArtifact();

  let missionId = RESUME;
  if (!missionId) {
    const created = await harnessMutation("missions.create", () =>
      cloud.mutation(api.missions.create, {
        workspaceId,
        title: scenario.goal.slice(0, 80),
        rawGoal: scenario.goal,
        constraints: [],
        sourceScope: "public-web",
        completionPredicate: "The mission's objective is met and recorded.",
      }),
    );
    missionId = created.missionId;
    evidence.missionId = String(missionId);
    writeEvidence();
    console.log(`  mission created: ${String(missionId).slice(0, 8)}…\n`);
    // "Run Radar" — after this the harness only observes and answers gates.
    const started = await harnessMutation("orchestratorStore.runPipeline", () => cloud.mutation(api.orchestratorStore.runPipeline, { workspaceId, missionId }));
    record("started", `runPipeline → ${JSON.stringify(started)}`);
  } else {
    evidence.missionId = String(missionId);
    record("resumed", `watching mission ${String(missionId).slice(0, 8)}…`);
  }

  const final = await runMission(missionId);
  evidence.final = summarise(final);
  evidence.terminal = final.run ? `${final.run.currentStage}/${final.run.status}` : "no run";

  // ── the external event: the counterpart replies, and the agent wakes ──
  if (scenario.counterpart) {
    const sent = final.drafts.find((draft) => ["sent", "delivered"].includes(draft.status));
    if (sent) {
      evidence.externalEvent = await injectReply(sent);
      const woken = await springForward(missionId, sent);
      evidence.finalAfterReply = summarise(woken);
    } else if (scenario.withdrawAfterApproval) {
      record("no send", "the send failed closed as intended (withdrawn authorization) — nothing was delivered");
    }
  }

  writeEvidence();
  console.log(`\nEvidence → ${EVIDENCE_RUN_PATH} (and ${EVIDENCE_PATH})`);
  console.log(`Terminal: ${evidence.terminal}`);
  console.log(`Harness calls: ${evidence.harnessCalls.length} (${[...new Set(evidence.harnessCalls.map((c) => c.name))].join(", ")})`);
  console.log(`Decisions: ${evidence.final.decisions.length} · drafts: ${evidence.final.drafts.length} · matches: ${evidence.final.matches.length} · sources: ${evidence.final.research.sources.length}`);
}

/** The counterpart answers inside the real provider thread (a genuine inbound message). */
async function injectReply(sent) {
  try {
    const list = await agentmail(`/inboxes/${scenario.counterpart}/messages?limit=10`);
    const messages = list.messages ?? [];
    const received = messages.find((m) => (m.subject ?? "").includes(sent.subject.slice(0, 24))) ?? messages[0];
    if (!received) {
      record("counterpart reply", "no message found in the counterpart inbox yet");
      return { injected: false };
    }
    const reply = await agentmail(`/inboxes/${scenario.counterpart}/messages/${received.message_id}/reply`, {
      method: "POST",
      body: JSON.stringify({ text: scenario.reply, subject: `Re: ${sent.subject}` }),
    });
    record("counterpart replied", `inside thread ${String(reply.thread_id ?? "").slice(0, 12)}… (real inbound message)`);
    return { injected: true, counterpartMessageId: received.message_id, replyMessageId: reply.message_id ?? null, threadId: reply.thread_id ?? null };
  } catch (error) {
    record("counterpart reply failed", error.message);
    return { injected: false, error: error.message };
  }
}

/** Waits for the deployed webhook to wake the mission and the agent to act on it. */
async function springForward(missionId, sent) {
  const started = Date.now();
  const woken = await watchUntil(
    missionId,
    (s, run) => {
      const replyRecorded = s.events.some((e) => String(e.type).includes("reply") || String(e.type).includes("inbound"));
      const progressed = ["observe", "continue", "complete"].includes(run.currentStage) || run.status === "complete" ||
        s.drafts.some((d) => d._id !== sent._id && ["draft", "awaiting_approval"].includes(d.status));
      return replyRecorded && progressed;
    },
    { label: "the reply to wake the mission", timeoutMs: 5 * 60 * 1000 },
  );
  evidence.wakeLatencyMs = Date.now() - started;
  evidence.wakeEvents = woken.events.map((e) => ({ type: e.type, stage: e.stage, at: new Date(e.createdAt).toISOString() }));
  return woken;
}

function summarise(snap) {
  const run = snap.run;
  return {
    run: run && { status: run.status, currentStage: run.currentStage, interruption: run.activeInterruption ?? null },
    plan: snap.plan && {
      normalizedGoal: snap.plan.normalizedGoal,
      mode: snap.plan.mode,
      successKind: snap.plan.successKind ?? null,
      targetCount: snap.plan.targetCount ?? null,
      userEditedAt: snap.plan.userEditedAt ?? null,
      mustHave: snap.plan.mustHave,
      recommendedSources: snap.plan.recommendedSources,
      completionPredicate: snap.plan.completionPredicate,
      model: snap.plan.model,
    },
    research: {
      jobs: snap.jobs.map((job) => ({ operation: job.operation, status: job.status, query: job.query, resultCount: job.resultCount ?? null, errorCode: job.errorCode ?? null })),
      sources: snap.sources.map((source) => ({ url: source.url, title: source.title, processingStatus: source.processingStatus, hasContent: Boolean(source.content) })),
    },
    entities: snap.entities.map((e) => ({ name: e.name, kind: e.kind, extractionStatus: e.extractionStatus, contactRoute: e.contactRoute ?? null, summary: e.summary ?? null })),
    matches: snap.matches.map((m) => ({ subject: m.subject, label: m.label, sourceUrl: m.sourceUrl, evidence: (m.positiveEvidence ?? []).slice(0, 2), unknowns: m.unknowns ?? [], recommendedAction: m.recommendedAction ?? null })),
    decisions: snap.decisions.map((d) => ({
      decision: d.decision, actionability: d.actionability, reason: d.reason, detail: d.detail,
      quality: d.quality, capability: d.capability, evidence: d.evidence, usedFacts: d.usedFacts,
      artifacts: d.artifacts, alternatives: d.alternatives, nextStage: d.nextStage, missingEvidence: d.missingEvidence,
      matchId: String(d.matchId),
    })),
    drafts: snap.drafts.map((d) => ({
      _id: String(d._id), status: d.status, to: "[redacted]", subject: d.subject, body: d.body,
      attachments: d.attachments, approvalStatus: d.approvalStatus, errorSummary: d.errorSummary ?? null,
      providerMessageId: d.providerMessageId ?? null, updatedAt: d.updatedAt,
    })),
    steps: snap.steps.map((s) => ({ stage: s.stage, label: s.label, tool: s.tool ?? null, errorCode: s.errorCode ?? null, summary: s.summary, createdAt: s.createdAt })),
    events: snap.events.map((e) => ({ type: e.type, stage: e.stage, summary: e.safeSummary, createdAt: e.createdAt })),
    budget: snap.budget && { creditLimit: snap.budget.creditLimit, used: snap.budget.used, remaining: snap.budget.remaining },
  };
}

main().catch((error) => {
  console.error("\nPROOF FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
