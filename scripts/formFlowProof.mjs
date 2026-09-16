// Real end-to-end form-flow proof run against the live deployment.
//
// The target is httpbin.org/forms/post — a public form built for exactly this
// purpose (it echoes the POST back), so the run proves the real pipeline
// without sending unsolicited messages to a real business.
//
// Usage:
//   CONVEX_URL=https://<deployment>.convex.cloud node scripts/formFlowProof.mjs
//   node scripts/formFlowProof.mjs --mission <missionId>   # resume a mission
//
// Writes evidence to proof/form-flow.json and the screenshot to
// proof/form-flow-screenshot.png. Never prints secrets.

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL || "https://wry-walrus-528.convex.cloud";
const WORKSPACE = "demo-workspace";
const FORM_URL = "https://httpbin.org/forms/post";
const OUT_DIR = "proof";

const client = new ConvexHttpClient(CONVEX_URL);

const argIndex = process.argv.indexOf("--mission");
const resumeMissionId = argIndex > -1 ? process.argv[argIndex + 1] : null;

const log = (step, detail) => console.log(`\n[${step}] ${detail}`);
const evidence = { capturedAt: new Date().toISOString(), convexUrl: CONVEX_URL, workspace: WORKSPACE, formUrl: FORM_URL };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function ensureMission() {
  if (resumeMissionId) {
    log("mission", `resuming ${resumeMissionId}`);
    const mission = (await client.query(api.missions.list, { workspaceId: WORKSPACE })).find((row) => row._id === resumeMissionId);
    if (!mission) throw new Error(`Mission ${resumeMissionId} is not in this workspace.`);
    evidence.mission = mission;
    return mission._id;
  }
  const created = await client.mutation(api.missions.create, {
    workspaceId: WORKSPACE,
    title: "Submit the httpbin test order form",
    rawGoal: `Submit the public test form at ${FORM_URL} with my details so I can prove the approval-bound form flow end to end.`,
    constraints: [],
    sourceScope: "public-web",
    completionPredicate: "A screenshot-evidenced public form submission exists.",
  });
  log("mission", `created ${created.missionId} (run ${created.runId})`);
  const mission = (await client.query(api.missions.list, { workspaceId: WORKSPACE })).find((row) => row._id === created.missionId);
  evidence.mission = mission;
  evidence.runId = created.runId;
  return created.missionId;
}

async function ensureFacts(missionId) {
  const existing = await client.query(api.context.list, { workspaceId: WORKSPACE, missionId: null });
  const wanted = [
    ["full_name", "Prospect Radar Proof Run"],
    ["email", "proof@prospect-radar.example"],
    ["phone", "+15550100"],
    ["delivery_instructions", "Automated end-to-end proof for the Convex All Gas Hackathon. No human is waiting on this order."],
    // These drive the grouped-control paths: a radio group must be chosen, and a
    // checkbox group may select several values. Getting the selector wrong shows
    // up as a failed action rather than a silent partial fill.
    ["pizza_size", "medium"],
    ["pizza_toppings", "bacon, cheese"],
  ];
  const added = [];
  for (const [category, value] of wanted) {
    const already = existing.find((fact) => fact.category === category && fact.value === value);
    if (already) {
      added.push({ category, value, factId: already._id, reused: true });
      continue;
    }
    const factId = await client.mutation(api.context.add, {
      workspaceId: WORKSPACE,
      missionId: null,
      category,
      value,
      sourceType: "user_input",
      sourceReference: null,
      confidence: 1,
      visibility: "workspace",
    });
    added.push({ category, value, factId, reused: false });
  }
  log("facts", `${added.filter((fact) => !fact.reused).length} added, ${added.filter((fact) => fact.reused).length} reused`);
  evidence.facts = added;
  void missionId;
}

async function ensureSource(missionId) {
  const sources = await client.query(api.researchStore.listSources, { missionId });
  const match = sources.find((source) => source.url.replace(/\/$/, "") === FORM_URL);
  if (match) {
    log("source", `already discovered ${match._id}`);
    evidence.source = match;
    return match._id;
  }
  log("search", `Firecrawl search for the form URL`);
  const result = await client.action(api.research.search, {
    missionId,
    requestId: randomUUID(),
    query: FORM_URL,
    limit: 5,
  });
  log("search", `job ${result.jobId} · ${result.resultCount} result(s)`);
  const refreshed = await client.query(api.researchStore.listSources, { missionId });
  const found = refreshed.find((source) => source.url.replace(/\/$/, "") === FORM_URL);
  if (!found) {
    console.log("\nSources returned:");
    for (const source of refreshed) console.log(`  - ${source.url}`);
    throw new Error("The form URL was not among the discovered sources; cannot scout it.");
  }
  evidence.source = found;
  log("source", `discovered ${found._id}`);
  return found._id;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const missionId = await ensureMission();
  await ensureFacts(missionId);
  const sourceId = await ensureSource(missionId);

  log("scout", "firecrawl form scout (json structured extraction)");
  const scouted = await client.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId, sourceId });
  log("scout", `${scouted.fieldCount} field(s) · blocked=${scouted.blockedReason ?? "none"} · ${scouted.formTitle}`);
  const templates = await client.query(api.formStore.listTemplates, { workspaceId: WORKSPACE, missionId });
  const template = templates.find((row) => row._id === scouted.templateId);
  evidence.template = template;
  if (template) {
    console.log("Fields:");
    for (const field of template.fields) {
      console.log(`  - ${field.name} (${field.type})${field.required ? " [required]" : ""} :: ${field.label} :: ${field.selector || "(no selector)"}`);
    }
    console.log(`Submit control: ${template.submitSelector || "(generic fallback)"}`);
  }
  if (scouted.blockedReason) {
    log("scout", `BLOCKED: ${scouted.blockedDetail}`);
    writeFileSync(`${OUT_DIR}/form-flow.json`, JSON.stringify(evidence, null, 2));
    return;
  }

  log("propose", "mapping confirmed facts onto the scouted fields");
  let proposal = null;
  try {
    const proposed = await client.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId, templateId: scouted.templateId });
    log("propose", `${proposed.filled} value(s) grounded, model ${proposed.model}${proposed.unmatchedRequired.length ? ` · unmatched: ${proposed.unmatchedRequired.join(", ")}` : ""}`);
    const proposals = await client.query(api.formStore.listProposals, { workspaceId: WORKSPACE, missionId });
    proposal = proposals.find((row) => row._id === proposed.proposalId) ?? null;
  } catch (error) {
    log("propose", `failed: ${error.message}`);
    evidence.error = String(error.message);
  }
  evidence.proposal = proposal;
  if (proposal) {
    console.log("Proposed payload:");
    for (const field of proposal.fieldValues) {
      console.log(`  - ${field.name}: ${field.value ? JSON.stringify(field.value) : "(empty)"}${field.factCategory ? `  <- ${field.factCategory}` : ""}`);
    }
    console.log(`Payload hash: ${proposal.payloadHash}`);
  }
  if (!proposal || proposal.unmatchedRequired.length > 0) {
    log("stop", "A required field is still unmatched, so approval is correctly refused.");
    writeFileSync(`${OUT_DIR}/form-flow.json`, JSON.stringify(evidence, null, 2));
    return;
  }

  log("approve", "binding the approval to the exact payload hash");
  const approval = await client.mutation(api.formStore.approveProposal, { workspaceId: WORKSPACE, proposalId: proposal._id });
  log("approve", `approved, expires ${new Date(approval.expiresAt).toISOString()}`);

  log("execute", "firecrawl actions + screenshot evidence");
  const executed = await client.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposal._id });
  log("execute", `${executed.status} · evidence=${executed.evidenceCaptured}`);
  console.log(executed.detail);

  await sleep(1500);
  const submissions = await client.query(api.formStore.listSubmissions, { workspaceId: WORKSPACE, missionId });
  const submission = submissions.find((row) => row.proposalId === proposal._id) ?? null;
  // Redact the signed storage URL: it is a temporary capability, and the
  // screenshot itself is committed next to this file instead.
  evidence.submission = submission
    ? {
        ...submission,
        evidenceUrl: undefined,
        evidenceStored: Boolean(submission.evidenceUrl),
        screenshotArtifact: "proof/form-flow-screenshot.png",
      }
    : null;
  if (submission) {
    console.log(`\nSubmission ${submission._id}`);
    console.log(`  status:   ${submission.status}`);
    console.log(`  target:   ${submission.url}`);
    console.log(`  fields:   ${submission.fieldCount}`);
    console.log(`  evidence: ${submission.evidenceUrl ? "yes" : "no"}`);
    console.log(`  excerpt:  ${submission.postSubmitExcerpt.slice(0, 220)}`);
    if (submission.evidenceUrl) {
      try {
        const response = await fetch(submission.evidenceUrl);
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          writeFileSync(`${OUT_DIR}/form-flow-screenshot.png`, bytes);
          log("evidence", `screenshot saved (${bytes.length} bytes) -> ${OUT_DIR}/form-flow-screenshot.png`);
        } else {
          log("evidence", `screenshot download failed: HTTP ${response.status}`);
        }
      } catch (error) {
        log("evidence", `screenshot download failed: ${error.message}`);
      }
    }
  }

  // Idempotency in the live system: a second execution must not submit again.
  const second = await client.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposal._id });
  const afterSecond = await client.query(api.formStore.listSubmissions, { workspaceId: WORKSPACE, missionId });
  evidence.idempotency = { secondStatus: second.status, submissionCount: afterSecond.length };
  log("idempotency", `second call -> ${second.status}; submissions for mission = ${afterSecond.length}`);

  const run = await client.query(api.runs.forMission, { missionId });
  if (run) {
    const steps = await client.query(api.runs.steps, { runId: run._id });
    evidence.transcript = steps.map((step) => ({ label: step.label, tool: step.tool ?? null, errorCode: step.errorCode, summary: step.summary, stage: step.stage }));
    log("transcript", `${steps.length} receipts recorded`);
    for (const step of steps.filter((row) => row.label.startsWith("form."))) {
      console.log(`  - ${step.label} [${step.tool ?? "—"}] ${step.summary}`);
    }
  }
  evidence.cap = await client.query(api.formStore.capStatus, { workspaceId: WORKSPACE });

  writeFileSync(`${OUT_DIR}/form-flow.json`, JSON.stringify(evidence, null, 2));
  log("done", `evidence written to ${OUT_DIR}/form-flow.json`);
}

main().catch((error) => {
  console.error("\nPROOF RUN FAILED:", error.message);
  process.exitCode = 1;
});
