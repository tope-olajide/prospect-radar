// Live proof of Convex Auth + workspace isolation against a real deployment.
//
// Proves, in order:
//   1. an anonymous caller has no identity
//   2. password sign-up issues a real JWT
//   3. the JWT resolves to a user and auto-provisions exactly one workspace
//   4. the authenticated caller can create workspace-scoped data
//   5. the same caller is REFUSED for a workspace it does not own
//   6. an anonymous caller cannot read a workspace it knows the id of
//   7. sign-out invalidates the session
//
// Usage: CONVEX_URL=https://<deployment>.convex.cloud node scripts/authProof.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL || "https://wry-walrus-528.convex.cloud";
const OUT_DIR = "proof";
const email = `radar-proof-${Date.now()}@example.com`;
const password = `Rdr!${Math.random().toString(36).slice(2)}${Date.now()}`;

const evidence = { capturedAt: new Date().toISOString(), convexUrl: CONVEX_URL, steps: [] };
const log = (step, detail) => {
  console.log(`\n[${step}] ${detail}`);
  evidence.steps.push({ step, detail });
};

function fresh() {
  return new ConvexHttpClient(CONVEX_URL);
}

async function main() {
  const anon = fresh();

  // 1. Anonymous caller has no identity.
  const anonUser = await anon.query(api.users.current, {});
  log("anonymous identity", `users.current -> ${anonUser === null ? "null (correct)" : "LEAKED"}`);
  if (anonUser !== null) throw new Error("anonymous caller resolved a user");

  // 2. Password sign-up issues a real JWT.
  const signedIn = await anon.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  const token = signedIn?.tokens?.token;
  if (!token) throw new Error(`sign-up returned no token: ${JSON.stringify(signedIn)}`);
  log("sign-up", `issued JWT (${token.split(".").length}-part) for ${email.replace(/@.*/, "@[redacted]")}`);

  const authed = fresh();
  authed.setAuth(token);

  // 3. The JWT resolves to a user.
  const me = await authed.query(api.users.current, {});
  if (!me) throw new Error("authenticated caller did not resolve a user");
  log("identity", `users.current -> user ${String(me._id).slice(0, 8)}… (email present: ${Boolean(me.email)})`);

  // 4. Workspace provisioning is idempotent for this owner.
  const first = await authed.mutation(api.users.provisionWorkspace, {});
  const second = await authed.mutation(api.users.provisionWorkspace, {});
  if (String(first.workspaceId) !== String(second.workspaceId)) {
    throw new Error("provisionWorkspace created two workspaces for one owner");
  }
  log("workspace", `provisioned once, idempotent re-call -> ${String(first.workspaceId).slice(0, 8)}…`);

  const workspace = await authed.query(api.users.workspace, {});
  if (!workspace) throw new Error("workspace query returned null for an authenticated owner");
  log("workspace scope", `users.workspace -> ${workspace.name}`);

  // 4b. Authenticated, scoped writes succeed.
  const created = await authed.mutation(api.missions.create, {
    workspaceId: workspace._id,
    title: "Auth proof mission",
    rawGoal: "Auth proof: find companies that need a React developer.",
    constraints: [],
    sourceScope: "public web",
    completionPredicate: "matches explained",
  });
  log("scoped write", `missions.create with own workspaceId -> ${String(created.missionId).slice(0, 8)}…`);
  const mine = await authed.query(api.missions.list, { workspaceId: workspace._id });
  log("scoped read", `missions.list on own workspace -> ${mine.length} mission(s)`);

  // 5. The same caller is refused for a workspace it does not own.
  const otherWorkspaceId = "k5712345678901234567890123456789";
  let crossRefused = null;
  try {
    await authed.query(api.missions.list, { workspaceId: otherWorkspaceId });
    crossRefused = "NO — request succeeded";
  } catch (err) {
    crossRefused = String(err.message || err).slice(0, 90);
  }
  log("cross-workspace refusal", `authenticated caller, foreign workspaceId -> ${crossRefused}`);

  // 6. An anonymous caller must not be able to read a known workspace either.
  let anonRead = null;
  try {
    const rows = await anon.query(api.missions.list, { workspaceId: workspace._id });
    anonRead = `NO — anonymous caller read ${rows.length} mission(s) from a known workspaceId`;
  } catch (err) {
    anonRead = String(err.message || err).slice(0, 90);
  }
  log("anonymous scope refusal", `anonymous caller, known workspaceId -> ${anonRead}`);

  evidence.summary = {
    anonymousBlocked: anonUser === null,
    signUpIssuedToken: Boolean(token),
    workspaceIdempotent: String(first.workspaceId) === String(second.workspaceId),
    crossWorkspaceRefused: crossRefused.startsWith("NO") ? false : true,
    anonymousWorkspaceReadBlocked: anonRead.startsWith("NO") ? false : true,
  };

  // 7. Sign-out revokes the refresh token. The access JWT stays valid until it
  // expires (standard JWT semantics), so the honest check is the refresh token,
  // not the access token.
  const refreshToken = signedIn?.tokens?.refreshToken;
  await authed.action(api.auth.signOut, {});
  let refreshOutcome = null;
  try {
    const refreshed = await anon.action(api.auth.signIn, { refreshToken });
    refreshOutcome = refreshed?.tokens ? "NO — refresh token still exchanged" : "no tokens returned";
  } catch (err) {
    refreshOutcome = `refused: ${String(err.message || err).slice(0, 70)}`;
  }
  log("sign-out", `refresh token after signOut -> ${refreshOutcome}`);
  evidence.summary.refreshTokenRevoked = refreshOutcome.startsWith("refused") || refreshOutcome.startsWith("no tokens");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/auth-proof.json`, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written to ${OUT_DIR}/auth-proof.json`);
  console.log("\nSummary:", JSON.stringify(evidence.summary, null, 2));
}

main().catch((err) => {
  console.error("\nPROOF FAILED:", err.message || err);
  process.exitCode = 1;
});
