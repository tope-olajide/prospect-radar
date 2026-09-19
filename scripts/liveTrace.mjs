#!/usr/bin/env node
/**
 * Reads a mission's persisted rows straight from the deployment.
 *
 * The live proof needs the *records*, not screenshots: which stage ran, what the
 * decision said and why, what evidence it rested on, what capability was chosen,
 * what actually happened, and what woke the mission afterwards. Some of those
 * tables are only reachable by a signed-in client, and the harness may have been
 * killed mid-run, so this reads the tables directly with a sandboxed readonly
 * inline query — the deployment is the source of truth either way.
 *
 * Usage: node scripts/liveTrace.mjs --mission <id> [--out proof/autonomy/<name>.json]
 *
 * Read-only. Prints a compact summary and writes the raw JSON.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : null;
};
const MISSION = flag("mission");
if (!MISSION) {
  console.error("Usage: node scripts/liveTrace.mjs --mission <missionId> [--out <path>]");
  process.exit(2);
}
const OUT = flag("out") ?? `proof/autonomy/trace-${MISSION}.json`;

// The CLI is invoked through node rather than a shell so the query string
// survives Windows quoting intact.
const CLI = new URL("../node_modules/convex/bin/main.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function inline(query) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "run", "--prod", "--inline-query", query], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
      maxBuffer: 60 * 1024 * 1024,
    });
    const start = stdout.search(/[[{]/);
    return start === -1 ? null : JSON.parse(stdout.slice(start));
  } catch (error) {
    return { __error: String(error.stdout ?? error.message).slice(0, 300) };
  }
}

const id = MISSION.replace(/[^a-z0-9]/gi, "");
const QUERY = `
  const missionId = "${id}";
  const byMission = (table) => ctx.db.query(table).withIndex("by_missionId", (q) => q.eq("missionId", missionId)).collect();
  const rows = {
    mission: await ctx.db.get("missions", missionId),
    run: (await byMission("agentRuns"))[0] ?? null,
    plan: (await byMission("missionPlans"))[0] ?? null,
    events: await byMission("runEvents"),
    steps: await byMission("runSteps"),
    decisions: await byMission("actionDecisions"),
    drafts: await byMission("actionDrafts"),
    matches: await byMission("matches"),
    sources: await byMission("sourceRecords"),
    entities: await byMission("entities"),
    signals: await byMission("entitySignals"),
    queries: await byMission("missionQueries"),
    outcomes: await byMission("outcomes"),
    researchJobs: await byMission("researchJobs"),
    charges: await byMission("creditCharges"),
  };
  rows.facts = (await ctx.db.query("contextFacts").collect()).filter((f) => f.workspaceId === rows.mission?.workspaceId);
  rows.inboxMessages = [];
  for (const draft of rows.drafts) {
    if (!draft.threadId) continue;
    const messages = await ctx.db.query("inboxMessages").withIndex("by_threadId", (q) => q.eq("threadId", draft.threadId)).collect();
    rows.inboxMessages.push(...messages);
  }
  rows.classifications = [];
  for (const message of rows.inboxMessages) {
    const rows2 = await ctx.db.query("replyClassifications").withIndex("by_messageId", (q) => q.eq("messageId", message._id)).collect();
    rows.classifications.push(...rows2);
  }
  return rows;
`;

const trace = inline(QUERY);
mkdirSync("proof/autonomy", { recursive: true });
writeFileSync(OUT, JSON.stringify(trace, null, 2));

if (trace?.__error) {
  console.error(`Read failed: ${trace.__error}`);
  process.exit(1);
}

const rows = (value) => (Array.isArray(value) ? value : []);
const at = (ms) => (ms ? new Date(ms).toISOString() : "-");
const clip = (value, n = 110) => String(value ?? "").replace(/\s+/g, " ").slice(0, n);

console.log(`\nPersisted trace — mission ${MISSION}`);
console.log(`run: ${trace.run?.currentStage}/${trace.run?.status}${trace.run?.activeInterruption ? ` (${trace.run.activeInterruption})` : ""} · retries ${trace.run?.retryCount ?? "?"}`);
if (trace.plan) {
  console.log(`objective: ${trace.plan.successKind ?? "(not stated — intent default)"} ×${trace.plan.targetCount ?? "-"}${trace.plan.userEditedAt ? " (user-set)" : ""}`);
  console.log(`predicate: ${clip(trace.plan.completionPredicate, 120)}`);
}

console.log(`\nlifecycle (${rows(trace.events).length} events, ${rows(trace.steps).length} steps):`);
for (const row of rows(trace.events)) {
  console.log(`  ${at(row.createdAt)}  event  ${row.stage}/${row.type}  ${clip(row.safeSummary)}`);
}
for (const row of rows(trace.steps).slice(-16)) {
  console.log(`  ${at(row.createdAt)}  step   ${row.stage}/${row.label}  ${clip(row.summary)}`);
}

console.log(`\ndecisions (${rows(trace.decisions).length}) — why Radar did what it did:`);
for (const row of rows(trace.decisions)) {
  console.log(`  ${row.decision}/${row.actionability} [${row.reason}] quality=${row.quality} capability=${row.capability ?? "-"} next=${row.nextStage ?? "-"}`);
  console.log(`      ${clip(row.detail, 150)}`);
  if (rows(row.usedFacts).length) console.log(`      authorized facts: ${clip(row.usedFacts.map((f) => `${f.category}=${f.value}`).join("; "), 140)}`);
  if (rows(row.artifacts).length) console.log(`      artifacts: ${row.artifacts.map((a) => a.title).join(", ")}`);
  if (rows(row.alternatives).length) console.log(`      rejected: ${clip(row.alternatives.map((a) => `${a.decision} (${a.reason})`).join(" | "), 180)}`);
  if (row.missingEvidence) console.log(`      missing: ${clip(row.missingEvidence, 120)}`);
  if (rows(row.evidence).length) console.log(`      evidence: ${clip(rows(row.evidence).slice(0, 2).join(" / "), 140)}`);
}

console.log(`\nresearch: ${rows(trace.sources).length} sources · ${rows(trace.entities).length} entities · ${rows(trace.signals).length} signals · ${rows(trace.matches).length} matches`);
for (const match of rows(trace.matches)) {
  console.log(`  match ${match.label}: ${clip(match.subject, 55)} · evidence ${rows(match.positiveEvidence).length} · ${clip(match.explanationSummary, 70)}`);
}

if (rows(trace.drafts).length) {
  console.log(`\ndrafts (${rows(trace.drafts).length}):`);
  for (const draft of rows(trace.drafts)) {
    console.log(`  ${draft.status} → ${draft.recipient.replace(/^(.{2}).*@/, "$1…@")} · "${clip(draft.subject, 60)}" · attachments ${rows(draft.artifactIds).length}${draft.errorSummary ? ` · error: ${clip(draft.errorSummary, 90)}` : ""}`);
  }
}
if (rows(trace.inboxMessages).length) {
  console.log(`\ninbound (${rows(trace.inboxMessages).length}) — the external events that wake missions:`);
  for (const message of rows(trace.inboxMessages)) {
    console.log(`  ${at(message.createdAt)}  from ${message.sender.replace(/^(.{2}).*@/, "$1…@")}  ${clip(message.preview, 90)}`);
  }
}
if (rows(trace.classifications).length) {
  console.log(`\nclassifications: ${rows(trace.classifications).map((c) => `${c.label} (${c.confidence})`).join(", ")}`);
}
if (rows(trace.outcomes).length) {
  console.log(`\noutcomes: ${rows(trace.outcomes).map((o) => `${o.counterpart}: ${o.stage}`).join(", ")}`);
}
const credits = rows(trace.charges).reduce((sum, row) => sum + row.amount, 0);
console.log(`\ncredits charged: ${credits} across ${rows(trace.charges).length} provider calls`);
console.log(`Written to ${OUT}`);
