#!/usr/bin/env node
/**
 * Live intent matrix (docs/integration-verification.md — sponsor proof).
 *
 * Runs 12 real missions against the LIVE production deployment through the same
 * public API the browser uses — 9 canonical intents, multi-intent, ambiguous,
 * and a context-dependent request — and captures, for each:
 *
 *   user request → AI classification (primary/secondary/rationale) →
 *   target entity → relationship goal → understanding → clarification →
 *   plan strategy (must-have criteria, search queries, crawl targets) →
 *   real Firecrawl discovery → sources persisted → matches
 *
 * Then it derives the cross-intent differences the product claim rests on:
 * different intents must produce different entity focus, different sources,
 * different evidence requirements, and different recommended actions — one
 * shared pipeline, different behavior per intent.
 *
 * Cost control: every mission is stopped (cancelled) as soon as its plan and
 * first discovery batch have landed, and its budget cap is freed, so a full
 * 12-mission sweep spends roughly what 2–3 complete missions would.
 *
 * Usage:
 *   AGENTMAIL_API_KEY not required. node scripts/intentMatrixProof.mjs
 *   node scripts/intentMatrixProof.mjs --keep   # let missions run to completion
 *
 * Writes proof/intent-matrix.json. Never prints or stores secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const CLOUD = process.env.CONVEX_CLOUD_URL ?? "https://wry-walrus-528.convex.cloud";
const WORKSPACE = process.env.PROOF_WORKSPACE ?? "demo-workspace";
const KEEP_RUNNING = process.argv.includes("--keep");

const CASES = [
  { key: "find_opportunity", goal: "Find companies that need a React/Next.js developer." },
  { key: "find_person", goal: "Find a React developer with SaaS experience." },
  { key: "find_solution", goal: "I need a solution for automating customer support." },
  { key: "find_customer", goal: "Find companies that could become customers for my SaaS." },
  { key: "find_collaborator", goal: "Find an AI engineer to collaborate with me." },
  { key: "find_service", goal: "I need someone to create API documentation." },
  { key: "find_client", goal: "Find clients that need frontend development." },
  { key: "find_provider", goal: "Find an agency that can handle SEO for a SaaS startup." },
  { key: "find_business", goal: "Find cybersecurity SaaS companies." },
  { key: "multi_intent", goal: "Find companies that need React development and help me turn the best ones into clients." },
  { key: "ambiguous", goal: "I need help with marketing." },
  { key: "context_dependent", goal: "Find companies that need what I do." },
];

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
      if (attempt < 5 && /fetch|network|timeout|ECONN|socket hang up|OTHER_ERROR/i.test(message)) {
        await sleep(2000 * attempt);
        return call(kind, path, args, attempt + 1);
      }
      throw new Error(`${path}: ${message}`);
    }
    return body.value;
  } catch (error) {
    if (attempt < 5 && /fetch failed|network|ECONN|socket hang up|ETIMEDOUT|terminated|OTHER_ERROR/i.test(String(error?.cause?.code ?? "") + " " + error.message)) {
      await sleep(2000 * attempt);
      return call(kind, path, args, attempt + 1);
    }
    throw error;
  }
}

const query = (path, args) => call("query", path, args);
const mutation = (path, args) => call("mutation", path, args);

/** Waits until `accept(value)` holds or the timeout elapses; returns the last value. */
async function until(fn, accept, { timeoutMs = 300_000, intervalMs = 8_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value && accept(value)) return value;
    await sleep(intervalMs);
  }
  return value;
}

async function runCase(testCase) {
  const entry = { key: testCase.key, goal: testCase.goal, steps: {} };
  console.log(`\n=== ${testCase.key} ===`);
  console.log(`  "${testCase.goal}"`);

  // 1. Mission from natural language only — no mode, no category.
  const created = await mutation("missions:create", {
    workspaceId: WORKSPACE,
    title: testCase.goal.slice(0, 80),
    rawGoal: testCase.goal,
    constraints: [],
    sourceScope: "public-web",
    completionPredicate: "A user-approved next action exists for at least one sourced match.",
  });
  entry.missionId = created.missionId;
  ids[testCase.key] = created.missionId;
  entry.steps.created = true;
  record(`${testCase.key}: mission created`, "✅ real", created.missionId);

  // 2. Start the run.
  const started = await mutation("orchestratorStore:runPipeline", {
    workspaceId: WORKSPACE,
    missionId: created.missionId,
  });
  entry.steps.started = Boolean(started?.started ?? started);

  // 3. Wait for the plan — the plan row only exists after both the classifier
  //    and the planner have run, and the plan carries the derived strategy.
  const planRow = await until(
    () => query("plans:getForMission", { missionId: created.missionId }),
    (value) => value != null,
    { timeoutMs: 300_000, intervalMs: 8_000, label: `${testCase.key} plan` },
  );
  if (!planRow) {
    entry.steps.plan = false;
    record(`${testCase.key}: plan`, "❌ missing", "no plan row appeared within the window");
    await stopMission(created.missionId);
    return entry;
  }

  // 4. The mission row carries the classifier's structured understanding.
  const rows = await query("missions:list", { workspaceId: WORKSPACE });
  const mission = rows.find((row) => row._id === created.missionId);
  entry.classification = {
    primary: mission?.intent?.primary ?? null,
    secondary: mission?.intent?.secondary ?? null,
    confidence: mission?.intent?.confidence ?? null,
    rationale: mission?.intent?.rationale ?? null,
    targetEntity: mission?.targetEntity ?? null,
    relationshipGoal: mission?.relationshipGoal ?? null,
    understanding: mission?.clarification ?? null,
    clarification: mission?.clarification ?? null,
    status: mission?.status ?? null,
  };
  entry.steps.classified = Boolean(entry.classification.primary);
  record(
    `${testCase.key}: classified`,
    entry.classification.primary ? "✅ real" : "❌ missing",
    `${entry.classification.primary ?? "?"}` +
    `${entry.classification.secondary ? ` + ${entry.classification.secondary}` : ""} · entity ${entry.classification.targetEntity ?? "?"}` +
    ` · relationship ${entry.classification.relationshipGoal ?? "?"} · confidence ${entry.classification.confidence ?? "?"}`,
  );
  if (entry.classification.rationale) record(`${testCase.key}: rationale`, "•", entry.classification.rationale.slice(0, 200));

  // 5. Strategy differences: what the planner derived from the intent.
  entry.strategy = {
    mode: planRow.mode ?? null,
    mustHave: planRow.mustHave ?? [],
    niceToHave: planRow.niceToHave ?? [],
    searchQueries: (planRow.recommendedSources ?? []).length,
    proposedSteps: planRow.proposedSteps ?? [],
    strategyNotes: planRow.strategyNotes ?? null,
  };
  entry.steps.planned = true;
  record(
    `${testCase.key}: strategy`,
    "✅ real",
    `mode ${entry.strategy.mode} · ${(planRow.mustHave ?? []).length} must-have · ${(planRow.niceToHave ?? []).length} nice-to-have`,
  );

  // 6. Wait for the first discovery batch to land so every intent shows real
  //    Firecrawl behavior, then stop the mission (cost control).
  const runRow = await until(
    () => query("runs:forMission", { missionId: created.missionId }),
    (value) => value && ["discover", "evaluate", "approval", "wait", "complete"].includes(value.currentStage),
    { timeoutMs: 420_000, intervalMs: 10_000, label: `${testCase.key} discovery` },
  );
  const sources = await query("researchStore:listSources", { missionId: created.missionId });
  const matches = await query("researchStore:listMatches", { missionId: created.missionId });
  const queries = await t_queries(created.missionId);
  entry.discovery = {
    runStage: runRow?.currentStage ?? null,
    runStatus: runRow?.status ?? null,
    sourceCount: sources.length,
    matchCount: matches.length,
    queriesPlanned: queries.total,
    queriesDone: queries.done,
    firstHosts: sources.slice(0, 5).map((source) => safeHost(source.url)),
  };
  entry.steps.discovered = sources.length > 0;
  record(
    `${testCase.key}: discovery`,
    sources.length > 0 ? "✅ real" : "⚠️ none yet",
    `${sources.length} sources · ${matches.length} matches · stage ${runRow?.currentStage ?? "?"} (${runRow?.status ?? "?"})` +
    (entry.discovery.firstHosts.length ? ` · hosts: ${entry.discovery.firstHosts.join(", ")}` : ""),
  );

  await stopMission(created.missionId);
  return entry;
}

async function t_queries(missionId) {
  try {
    const jobs = await query("researchStore:listJobs", { missionId });
    return { total: jobs.length, done: jobs.filter((job) => job.status === "complete").length };
  } catch {
    return { total: 0, done: 0 };
  }
}

async function stopMission(missionId) {
  if (KEEP_RUNNING) return;
  try {
    await mutation("orchestratorStore:stopRun", { workspaceId: WORKSPACE, missionId });
  } catch {
    // A run already at a gate or finished cannot be cancelled; nothing to do.
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url).slice(0, 40);
  }
}

// ------------------------------------------------------------------ driver

async function main() {
  console.log(`Intent matrix proof against ${CLOUD} (workspace ${WORKSPACE})\n`);
  const results = [];
  for (const testCase of CASES) {
    try {
      results.push(await runCase(testCase));
    } catch (error) {
      record(`${testCase.key}: FAILED`, "❌ error", String(error.message ?? error).slice(0, 200));
      results.push({ key: testCase.key, goal: testCase.goal, error: String(error.message ?? error).slice(0, 300) });
      if (ids[testCase.key]) await stopMission(ids[testCase.key]);
    }
  }

  // ---- derived matrix: proof that intent changes strategy, not just labels ----
  const byKey = Object.fromEntries(results.map((row) => [row.key, row]));
  const intents = CASES.filter((testCase) => !["multi_intent", "ambiguous", "context_dependent"].includes(testCase.key)).map((testCase) => testCase.key);
  const distinctEntities = new Set(intents.map((key) => byKey[key]?.classification?.targetEntity).filter(Boolean));
  const distinctRelationships = new Set(intents.map((key) => byKey[key]?.classification?.relationshipGoal).filter(Boolean));
  const distinctModes = new Set(intents.map((key) => byKey[key]?.strategy?.mode).filter(Boolean));
  const classified = intents.filter((key) => byKey[key]?.classification?.primary === key.replace("_", "")).length;
  const primaryMatched = intents.filter((key) => {
    const primary = byKey[key]?.classification?.primary ?? "";
    return primary === key || primary.endsWith(key.split("_")[1] ?? key);
  }).length;
  const multi = byKey.multi_intent;
  const ambiguous = byKey.ambiguous;
  const contextCase = byKey.context_dependent;

  const derived = {
    nineCanonicalClassified: primaryMatched,
    of: intents.length,
    distinctTargetEntities: [...distinctEntities],
    distinctRelationshipGoals: [...distinctRelationships].slice(0, 12),
    distinctPlanModes: [...distinctModes],
    multiIntentSecondaryCaptured: Boolean(multi?.classification?.secondary),
    multiIntentDetail: multi?.classification?.secondary ?? null,
    ambiguousAskedClarification: Boolean(ambiguous?.classification?.clarification) || ambiguous?.classification?.status === "blocked",
    ambiguousDetail: ambiguous?.classification?.clarification ?? null,
    contextResolvedFromProfile: Boolean(contextCase?.classification?.primary) && !contextCase?.classification?.clarification,
    contextDetail: contextCase?.classification?.rationale ?? null,
    perIntent: results.map((row) => ({
      key: row.key,
      primary: row.classification?.primary ?? null,
      secondary: row.classification?.secondary ?? null,
      entity: row.classification?.targetEntity ?? null,
      relationship: row.classification?.relationshipGoal ?? null,
      mode: row.strategy?.mode ?? null,
      mustHave: (row.strategy?.mustHave ?? []).slice(0, 2),
      sources: row.discovery?.sourceCount ?? 0,
      hosts: row.discovery?.firstHosts ?? [],
    })),
  };

  mkdirSync("proof", { recursive: true });
  writeFileSync(
    "proof/intent-matrix.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), deployment: CLOUD, workspace: WORKSPACE, results, derived }, null, 2),
  );

  const ok = results.filter((row) => !row.error && row.steps?.classified).length;
  console.log(`\n${ok}/${CASES.length} intents classified → proof/intent-matrix.json`);
  console.log(`distinct entities: ${derived.distinctTargetEntities.join(", ")}`);
  console.log(`distinct relationship goals: ${derived.distinctRelationshipGoals.length}`);
  console.log(`multi-intent secondary: ${derived.multiIntentDetail ?? "none"}`);
  console.log(`ambiguous clarification: ${derived.ambiguousDetail ?? "none"}`);
}

await main();
