#!/usr/bin/env node
/**
 * Failure-path proofs (docs/execution-plan.md Phase 7, item 2).
 *
 * Proves that the dangerous paths fail closed, and records the evidence in
 * `proof/failure-paths.json` in the shape docs/integration-verification.md §7
 * requires (step, Convex function, provider operation, external reference,
 * status, and whether the proof is real or test-verified).
 *
 * Two kinds of proof, labelled honestly:
 *  - REAL: probed against the live production deployment right now.
 *  - TEST-VERIFIED: the scenario cannot be forced through the public API (an
 *    expired approval, a tampered payload after approval), so it is proven by a
 *    named test executed here, with the test name and result recorded.
 *
 * Usage:
 *   node scripts/failurePathsProof.mjs
 *   CONVEX_SITE_URL=https://x.convex.site CONVEX_CLOUD_URL=https://x.convex.cloud node scripts/failurePathsProof.mjs
 *
 * Never prints or stores secrets. `AGENTMAIL_WEBHOOK_SECRET` is not required:
 * the probes assert that traffic WITHOUT a valid signature is rejected, which
 * needs no secret at all.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CLOUD = process.env.CONVEX_CLOUD_URL ?? "https://wry-walrus-528.convex.cloud";
const SITE = process.env.CONVEX_SITE_URL ?? "https://wry-walrus-528.convex.site";
const WORKSPACE = process.env.PROOF_WORKSPACE ?? "demo-workspace";

const entries = [];

function record(entry) {
  entries.push({ at: new Date().toISOString(), environment: "prod wry-walrus-528", ...entry });
}

async function call(kind, path, args, attempt = 1) {
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
    body = { raw: text.slice(0, 400) };
  }
  if (body.status === "error") {
    // Convex surfaces transient transport failures as errors too; retry those.
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return call(kind, path, args, attempt + 1);
    }
    throw new Error(`${path}: ${body.errorMessage ?? "unknown error"}`);
  }
  return body.value;
}

const query = (path, args) => call("query", path, args);
const mutation = (path, args) => call("mutation", path, args);
const action = (path, args) => call("action", path, args);

async function webhookProbe(label, headers, attempt = 1) {
  try {
    const response = await fetch(`${SITE}/agentmail/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ type: "message.received", data: {} }),
    });
    const text = await response.text();
    return { label, status: response.status, body: text.slice(0, 160) };
  } catch (error) {
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return webhookProbe(label, headers, attempt + 1);
    }
    return { label, status: 0, body: `transport error: ${error.message}` };
  }
}

// ---------------------------------------------------------------- F1/F2: webhook

async function proofWebhookTransport() {
  const unsigned = await webhookProbe("unsigned", {});
  record({
    id: "F1",
    step: "Unsigned webhook is rejected",
    convexFunction: "http.ts → /agentmail/webhook (svix verification)",
    sponsorOperation: "AgentMail webhook transport",
    externalIds: `POST /agentmail/webhook (no signature) → HTTP ${unsigned.status}`,
    status: unsigned.status === 401 ? "✅ real" : `❌ unexpected ${unsigned.status}`,
    verdict: unsigned.status === 401,
  });

  const forged = await webhookProbe("forged-svix", {
    "svix-id": "msg_forged_proof",
    "svix-timestamp": String(Math.floor(Date.now() / 1000)),
    "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  record({
    id: "F2",
    step: "A forged svix signature is rejected",
    convexFunction: "http.ts → /agentmail/webhook (svix verification)",
    sponsorOperation: "AgentMail webhook transport",
    externalIds: `POST /agentmail/webhook (forged svix-signature) → HTTP ${forged.status}`,
    status: forged.status === 401 ? "✅ real" : `❌ unexpected ${forged.status}`,
    verdict: forged.status === 401,
  });
}

// ------------------------------------------------- F3: a live LOGIN_REQUIRED stop

const LOGIN_CANDIDATES = [
  "https://github.com/login",
  "https://gitlab.com/users/sign_in",
  "https://news.ycombinator.com/login",
];

async function proofLoginRequired() {
  let mission;
  try {
    mission = await mutation("missions:create", {
      workspaceId: WORKSPACE,
      title: "Failure-path proof: login wall",
      rawGoal: "Failure-path proof: confirm Radar stops at an authentication wall.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A blocked login wall is recorded.",
    });
  } catch (error) {
    record({
      id: "F3",
      step: "Live login wall stops the form flow",
      convexFunction: "formFlows.scoutForm",
      sponsorOperation: "Firecrawl structured extraction (json format)",
      externalIds: `not reached: ${error.message}`,
      status: "❓ not reached (transport)",
      verdict: false,
    });
    return;
  }

  let found = null;
  let lastError = null;
  for (const url of LOGIN_CANDIDATES) {
    try {
      await action("research:search", {
        missionId: mission.missionId,
        requestId: `login-proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        query: url,
        limit: 5,
      });
      const sources = await query("researchStore:listSources", { missionId: mission.missionId });
      const match = sources.find((source) => source.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
      if (!match) continue;

      const scout = await action("formFlows:scoutForm", {
        workspaceId: WORKSPACE,
        missionId: mission.missionId,
        sourceId: match._id,
      });
      found = { url, sourceId: match._id, scout };
      break;
    } catch (error) {
      // Try the next candidate; a search miss is not a proof failure.
      lastError = error.message;
    }
  }

  if (!found) {
    record({
      id: "F3",
      step: "Live login wall stops the form flow",
      convexFunction: "formFlows.scoutForm",
      sponsorOperation: "Firecrawl structured extraction (json format)",
      externalIds: `tried ${LOGIN_CANDIDATES.length} public login pages; none resolved to a source` +
        (lastError ? ` (last error: ${lastError})` : ""),
      status: "❓ not reached (search did not surface the page)",
      verdict: false,
    });
    return;
  }

  const blocked = ["login_required", "human_check_required"].includes(found.scout.blockedReason);
  record({
    id: "F3",
    step: "Live login wall stops the form flow",
    convexFunction: "formFlows.scoutForm",
    sponsorOperation: "Firecrawl structured extraction (json format)",
    externalIds: `source ${found.sourceId} = ${found.url} → blockedReason: ${found.scout.blockedReason ?? "null"}; ${found.scout.fieldCount} fields scouted and refused`,
    status: blocked ? "✅ real" : `❌ not blocked (${found.scout.blockedReason ?? "null"})`,
    verdict: blocked,
  });
}

// ------------------------------------------- F4-F8: test-verified failure paths

const REQUIRED_TESTS = [
  { id: "F4", file: "tests/trust.test.ts", name: "accepts an event once and ignores replays by event_id", step: "Replayed webhook event is ignored by event id", convexFunction: "inbox.ingestEvent", sponsorOperation: "AgentMail webhook ingest" },
  { id: "F5", file: "tests/trust.test.ts", name: "blocks a send with an expired approval", step: "Expired approval cannot send", convexFunction: "outreach.send → outreachStore.claimSend", sponsorOperation: "AgentMail send (approval-bound)" },
  { id: "F6", file: "tests/trust.test.ts", name: "blocks a send when draft content is mutated after approval (hash mismatch)", step: "Tampered payload cannot send", convexFunction: "outreach.send → contentHash recheck", sponsorOperation: "AgentMail send (approval-bound)" },
  { id: "F7", file: "tests/trust.test.ts", name: "refuses to send without any approval and records no side effects", step: "Approval bypass is refused", convexFunction: "outreach.send", sponsorOperation: "AgentMail send (approval-bound)" },
  { id: "F8", file: "tests/trust.test.ts", name: "rejects a send from another workspace even with an active approval", step: "Cross-workspace send is refused", convexFunction: "outreach.send", sponsorOperation: "AgentMail send (workspace scope)" },
  { id: "F9", file: "tests/forms.test.ts", name: "binds the approval to the payload hash and refuses a mutated payload", step: "Tampered form payload cannot submit", convexFunction: "formStore.claimExecution", sponsorOperation: "Firecrawl form submission (approval-bound)" },
  { id: "F10", file: "tests/forms.test.ts", name: "flags a login wall as login_required and never proposes to fill it", step: "Login wall blocks at scouting", convexFunction: "formFlows.scoutForm", sponsorOperation: "Firecrawl structured extraction" },
  { id: "F11", file: "tests/forms.test.ts", name: "records a detected human check as blocked, never as failed or submitted", step: "Human check records blocked, never fabricated as submitted", convexFunction: "formFlows.executeFormSubmission", sponsorOperation: "Firecrawl form submission" },
  { id: "F12", file: "tests/forms.test.ts", name: "records an authentication wall as blocked_login", step: "Auth wall records blocked_login at execution", convexFunction: "formFlows.executeFormSubmission", sponsorOperation: "Firecrawl form submission" },
  { id: "F13", file: "tests/forms.test.ts", name: "refuses to run without an approval", step: "Form submission without approval is refused", convexFunction: "formFlows.executeFormSubmission", sponsorOperation: "Firecrawl form submission (approval-bound)" },
];

function runRequiredTests() {
  mkdirSync("proof", { recursive: true });
  const outputFile = "proof/.failure-path-tests.json";
  const files = [...new Set(REQUIRED_TESTS.map((test) => test.file))];
  try {
    // A single command string: `npx` is a shell script on Windows, so spawning
    // it directly fails there.
    execSync(`npx vitest run ${files.join(" ")} --reporter=json --outputFile=${outputFile}`, {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // A non-zero exit still writes the report; parse whatever is there.
  }
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  const passed = new Set();
  for (const suite of report.testResults ?? []) {
    // The reporter reports absolute paths; compare on the file's basename.
    const file = String(suite.name ?? "").split(/[\\/]/).pop();
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "passed") passed.add(`${file}::${assertion.title}`);
    }
  }
  return (test) => passed.has(`${test.file.split("/").pop()}::${test.name}`);
}

function proofRequiredTests() {
  const didPass = runRequiredTests();
  for (const test of REQUIRED_TESTS) {
    const ok = didPass(test);
    record({
      id: test.id,
      step: test.step,
      convexFunction: test.convexFunction,
      sponsorOperation: test.sponsorOperation,
      externalIds: `${test.file} → "${test.name}"`,
      status: ok ? "✅ test-verified" : "❌ test did not pass",
      verdict: ok,
    });
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  console.log(`Failure-path proofs against ${CLOUD} (site ${SITE})\n`);
  await proofWebhookTransport();
  await proofLoginRequired();
  proofRequiredTests();

  const failed = entries.filter((entry) => !entry.verdict);
  const artifact = {
    generatedAt: new Date().toISOString(),
    environment: "prod wry-walrus-528",
    cloud: CLOUD,
    site: SITE,
    workspace: WORKSPACE,
    summary: {
      total: entries.length,
      proven: entries.length - failed.length,
      failed: failed.length,
      real: entries.filter((entry) => entry.status.startsWith("✅ real")).length,
      testVerified: entries.filter((entry) => entry.status.startsWith("✅ test-verified")).length,
    },
    entries,
  };
  mkdirSync("proof", { recursive: true });
  writeFileSync("proof/failure-paths.json", `${JSON.stringify(artifact, null, 2)}\n`);

  console.log("id | step | status");
  for (const entry of entries) console.log(`${entry.id.padEnd(3)} | ${entry.step.padEnd(62)} | ${entry.status}`);
  console.log(`\n${artifact.summary.proven}/${artifact.summary.total} proven ` +
    `(${artifact.summary.real} real, ${artifact.summary.testVerified} test-verified) → proof/failure-paths.json`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("proof run failed:", error.message);
  process.exitCode = 1;
});
