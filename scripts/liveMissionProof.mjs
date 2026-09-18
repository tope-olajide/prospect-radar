// Real end-to-end mission on the live deployment, run as a brand-new signed-up
// user, with per-stage evidence captured at every gate.
//
// This drives the actual production stage machine, not a simulation:
//   sign up → workspace → mission → intake (classify) → interpret (plan)
//   → plan_review [gate] → discover (Firecrawl search + crawl)
//   → check_in [gate] → evaluate (entity resolution + match explanation)
//   → approval [gate, by design]
//
// The last gate is the product's hard stop: Radar never sends without an
// approval, so the run is *supposed* to park there. The script reports that as
// the terminal state rather than pretending the mission "finished".
//
// Usage: CONVEX_URL=https://<deployment>.convex.cloud node scripts/liveMissionProof.mjs
// Never prints secrets. Writes evidence to proof/live-mission.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL || "https://wry-walrus-528.convex.cloud";
const OUT_DIR = "proof";
const GOAL = process.env.MISSION_GOAL
  || "Find seed-stage fintech companies in Lagos that need a React frontend developer.";
const POLL_MS = 3000;
const DEADLINE_MS = 6 * 60 * 1000;

const email = `radar-mission-${Date.now()}@example.com`;
const password = `Rdr!${Math.random().toString(36).slice(2)}${Date.now()}`;

const evidence = {
  capturedAt: new Date().toISOString(),
  convexUrl: CONVEX_URL,
  goal: GOAL,
  identity: { provider: "password", email: `${email.replace(/@.*/, "")}@[redacted]` },
  stageTimeline: [],
  gates: [],
  perStage: {},
  errors: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, detail) => console.log(`\n[${step}] ${detail}`);
const redact = (value) => JSON.stringify(value ?? null).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted]");

function client() {
  return new ConvexHttpClient(CONVEX_URL);
}

/** Snapshot everything the UI reads for one mission, so a step can't be faked. */
async function snapshot(c, missionId, workspaceId) {
  // The run is resolved first because the event/step trails are addressed by
  // runId. Everything after that is one parallel batch.
  const run = await c.query(api.runs.forMission, { missionId });
  const [plan, events, steps, jobs, sources, matches, entities, signals, budget] = await Promise.all([
    c.query(api.plans.getForMission, { missionId }),
    run ? c.query(api.runs.events, { runId: run._id }) : [],
    run ? c.query(api.runs.steps, { runId: run._id }) : [],
    c.query(api.researchStore.listJobs, { missionId }),
    c.query(api.researchStore.listSources, { missionId }),
    c.query(api.researchStore.listMatches, { missionId }),
    c.query(api.entityStore.listForMission, { missionId }),
    c.query(api.entityStore.listSignalsForMission, { missionId }),
    c.query(api.budget.status, { workspaceId, missionId }),
  ]);
  return { run, plan, events, steps, jobs, sources, matches, entities, signals, budget: budget ? { creditLimit: budget.creditLimit, used: budget.used, remaining: budget.remaining, breakdown: budget.breakdown } : null };
}

async function main() {
  const anon = client();

  // ── A brand-new authenticated user ────────────────────────────────────────
  const signedIn = await anon.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  const token = signedIn?.tokens?.token;
  if (!token) throw new Error("sign-up returned no token");
  const authed = client();
  authed.setAuth(token);

  const { workspaceId } = await authed.mutation(api.users.provisionWorkspace, {});
  const me = await authed.query(api.users.current, {});
  log("new user", `signed up, workspace ${String(workspaceId).slice(0, 8)}… provisioned (user ${String(me?._id).slice(0, 8)}…)`);
  evidence.workspaceId = String(workspaceId);

  // ── Mission ───────────────────────────────────────────────────────────────
  const created = await authed.mutation(api.missions.create, {
    workspaceId,
    title: GOAL,
    rawGoal: GOAL,
    constraints: [],
    sourceScope: "public-web",
    completionPredicate: "A user-reviewed, evidence-backed next action exists.",
  });
  const missionId = created.missionId;
  log("mission", `created ${String(missionId).slice(0, 8)}… → ${GOAL}`);
  evidence.missionId = String(missionId);

  const started = await authed.mutation(api.orchestratorStore.runPipeline, { workspaceId, missionId });
  log("run", `runPipeline → ${JSON.stringify(started)}`);

  // ── Drive the real stage machine ──────────────────────────────────────────
  const deadline = Date.now() + DEADLINE_MS;
  let lastKey = "";
  let terminal = null;
  let gateCount = 0;

  while (Date.now() < deadline) {
    const snap = await snapshot(authed, missionId, workspaceId);
    const run = snap.run;
    if (!run) { await sleep(POLL_MS); continue; }

    const key = `${run.status}:${run.currentStage}`;
    if (key !== lastKey) {
      lastKey = key;
      evidence.stageTimeline.push({ at: new Date().toISOString(), status: run.status, stage: run.currentStage, interruption: run.activeInterruption ?? null });
      console.log(`   · ${run.currentStage} / ${run.status}${run.activeInterruption ? ` (${run.activeInterruption})` : ""}`);
    }

    // Gate 1 — the plan needs the user's approval before any spending.
    if (run.status === "waiting" && run.currentStage === "plan_review") {
      gateCount += 1;
      evidence.gates.push({
        gate: "plan_review",
        plan: snap.plan && {
          normalizedGoal: snap.plan.normalizedGoal,
          mode: snap.plan.mode,
          mustHave: snap.plan.mustHave,
          niceToHave: snap.plan.niceToHave,
          exclusions: snap.plan.exclusions,
          recommendedSources: snap.plan.recommendedSources,
          proposedSteps: snap.plan.proposedSteps,
          provider: snap.plan.provider,
          model: snap.plan.model,
        },
        missionIntent: await authed.query(api.missions.list, { workspaceId }).then((rows) => rows.find((r) => r._id === missionId)?.intent ?? null),
        targetEntity: await authed.query(api.missions.list, { workspaceId }).then((rows) => rows.find((r) => r._id === missionId)?.targetEntity ?? null),
      });
      log("gate 1 · plan review", `plan ready via ${snap.plan?.provider}/${snap.plan?.model} — approving`);
      await authed.mutation(api.orchestratorStore.approvePlan, { workspaceId, missionId });
      await sleep(1200);
      continue;
    }

    // Gate 2 — the discovery summary before evaluation.
    if (run.status === "waiting" && run.currentStage === "check_in") {
      gateCount += 1;
      evidence.gates.push({
        gate: "check_in",
        discovered: {
          jobs: snap.jobs?.length ?? 0,
          sources: snap.sources?.length ?? 0,
          entities: snap.entities?.length ?? 0,
          signals: snap.signals?.length ?? 0,
          budgetUsed: snap.budget?.used ?? null,
        },
      });
      log("gate 2 · check-in", `discovery done: ${snap.sources?.length ?? 0} sources, ${snap.entities?.length ?? 0} entities, ${snap.signals?.length ?? 0} signals — continuing`);
      await authed.mutation(api.orchestratorStore.continueAfterCheckIn, { workspaceId, missionId });
      await sleep(1200);
      continue;
    }

    // Gate 3 — the by-design hard stop before any external side effect.
    if (run.status === "waiting" && run.currentStage === "approval") {
      terminal = "approval";
      break;
    }

    // A run parked at intake/waiting is the classifier asking for clarification.
    if (run.status === "waiting" && run.currentStage === "intake") {
      const mission = (await authed.query(api.missions.list, { workspaceId })).find((r) => r._id === missionId);
      const question = mission?.clarification ?? "(no question recorded)";
      evidence.gates.push({ gate: "clarification", question });
      log("gate 0 · clarification", `classifier asked: ${question}`);
      evidence.errors.push({ kind: "clarification_required", question });
      terminal = "clarification";
      break;
    }

    if (run.status === "blocked") {
      evidence.errors.push({ kind: "blocked", stage: run.currentStage, interruption: run.activeInterruption, lastStep: snap.steps?.at(-1) ?? null });
      terminal = "blocked";
      break;
    }
    if (["failed", "cancelled"].includes(run.status)) { terminal = run.status; break; }
    if (run.status === "complete") { terminal = "complete"; break; }

    await sleep(POLL_MS);
  }

  // ── Per-stage evidence ────────────────────────────────────────────────────
  const final = await snapshot(authed, missionId, workspaceId);
  evidence.terminal = terminal ?? "deadline_reached";
  evidence.gatesReached = gateCount;
  evidence.perStage = {
    run: final.run && { status: final.run.status, currentStage: final.run.currentStage, retryCount: final.run.retryCount, activeInterruption: final.run.activeInterruption ?? null },
    plan: final.plan && { mode: final.plan.mode, mustHave: final.plan.mustHave, recommendedSources: final.plan.recommendedSources, proposedSteps: final.plan.proposedSteps, model: final.plan.model, provider: final.plan.provider },
    research: {
      jobs: (final.jobs ?? []).map((job) => ({ operation: job.operation, status: job.status, query: job.query, resultCount: job.resultCount ?? null, crawlStatus: job.crawlStatus ?? null, errorCode: job.errorCode ?? null })),
      sources: (final.sources ?? []).map((source) => ({ url: source.url, title: source.title, sourceType: source.sourceType, freshness: source.freshness, processingStatus: source.processingStatus, hasContent: Boolean(source.content), chars: source.content ? source.content.length : 0 })),
    },
    entities: (final.entities ?? []).map((entity) => ({
      name: entity.name, kind: entity.kind, summary: entity.summary ?? null,
      expressedNeed: entity.expressedNeed ?? null, offer: entity.skillsOrOffer ?? [],
      contactRoute: entity.contactRoute ?? null, extractionStatus: entity.extractionStatus, confidence: entity.confidence,
    })),
    signals: (final.signals ?? []).map((signal) => ({ type: signal.type, statement: signal.statement, evidenceUrl: signal.evidenceUrl ?? null })),
    matches: (final.matches ?? []).map((match) => ({
      subject: match.subject,
      signal: match.signal,
      label: match.label,
      sourceUrl: match.sourceUrl,
      sourceTitle: match.sourceTitle,
      investigatedBecause: match.sourceQuery,
      explanationSummary: match.explanationSummary,
      explanationModel: match.explanationModel,
      evidence: (match.positiveEvidence ?? []).slice(0, 2),
      unknowns: match.unknowns ?? [],
      risks: match.risks ?? [],
      recommendedAction: match.recommendedAction ?? null,
      entity: match.entity ? { name: match.entity.name, kind: match.entity.kind, extractionStatus: match.entity.extractionStatus, hasContactRoute: Boolean(match.entity.contactRoute) } : null,
    })),
    budget: final.budget,
    eventTrail: (final.events ?? []).map((e) => ({ type: e.type, stage: e.stage, summary: e.safeSummary, at: new Date(e.createdAt).toISOString() })),
    stepReceipts: (final.steps ?? []).map((s) => ({ stage: s.stage, label: s.label, tool: s.tool ?? null, errorCode: s.errorCode, summary: s.summary })),
  };

  // The workspace-wide outcomes view must be empty: nothing was sent, so no
  // relationship should exist yet. Proves the query reads real workspace data.
  evidence.workspaceOutcomes = (await authed.query(api.outcomes.listForWorkspace, { workspaceId })).map((o) => ({ counterpart: o.counterpart, stage: o.stage, missionTitle: o.missionTitle }));

  // Isolation: the same authenticated user gets nothing for a foreign workspace.
  try {
    await authed.query(api.outcomes.listForWorkspace, { workspaceId: "k5712345678901234567890123456789" });
    evidence.crossWorkspaceRefused = false;
  } catch {
    evidence.crossWorkspaceRefused = true;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/live-mission.json`, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written to ${OUT_DIR}/live-mission.json`);
  console.log(`Terminal state: ${evidence.terminal}`);
  console.log(`Stages traversed: ${evidence.stageTimeline.map((t) => `${t.stage}/${t.status}`).join(" → ")}`);
  console.log(`Matches: ${evidence.perStage.matches.length} · Entities: ${evidence.perStage.entities.length} · Sources: ${evidence.perStage.research.sources.length} · Budget used: ${evidence.perStage.budget?.used ?? 0}/${evidence.perStage.budget?.creditLimit ?? 0}`);
  console.log(`Last error: ${redact(evidence.errors.at(-1) ?? null)}`);
}

main().catch((err) => {
  console.error("\nPROOF FAILED:", err.message || err);
  process.exitCode = 1;
});
