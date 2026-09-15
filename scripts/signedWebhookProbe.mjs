// Signed end-to-end webhook probe against the live deployment.
// Usage: CONVEX_SITE_URL=... AGENTMAIL_WEBHOOK_SECRET=... node scripts/signedWebhookProbe.mjs
// The secret is read from the environment and never printed.
import { Webhook } from "svix";

const url = process.env.CONVEX_SITE_URL;
// Keep only the whsec token: guards against npx/npm banners polluting stdout
// when the caller interpolates `npx convex env get` output.
const secret = process.env.AGENTMAIL_WEBHOOK_SECRET?.match(/whsec_[A-Za-z0-9+/=_-]+/)?.[0];
if (!url || !secret) {
  console.error("Set CONVEX_SITE_URL and a valid whsec_… AGENTMAIL_WEBHOOK_SECRET.");
  process.exit(2);
}
try {
  new Webhook(secret);
} catch (error) {
  console.error("Signing secret failed to initialize:", error instanceof Error ? error.message : error);
  process.exit(2);
}

const endpoint = `${url.replace(/\/$/, "")}/agentmail/webhook`;
const event = {
  event_id: `probe-${Date.now()}`,
  event_type: "message.received",
  message: {
    inbox_id: "probe-inbox",
    thread_id: "probe-thread",
    message_id: "probe-msg-1",
    from: "probe@example.test",
    from_: ["probe@example.test"],
    to: ["probe-inbox@agentmail.to"],
    subject: "Webhook probe",
    preview: "Signed transport verification event.",
    timestamp: new Date().toISOString(),
  },
};
const payload = JSON.stringify(event);
const sentAt = new Date();
const timestamp = Math.floor(sentAt.getTime() / 1000).toString();
const wh = new Webhook(secret);
const signature = wh.sign(event.event_id, sentAt, payload);

async function post(headers, label) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
  const body = await response.text();
  return { label, status: response.status, body };
}

// 1. Validly signed event must be accepted.
const signed = await post(
  { "svix-id": event.event_id, "svix-timestamp": timestamp, "svix-signature": signature },
  "signed",
);
console.log(`[${signed.label}] HTTP ${signed.status} ${signed.body}`);
if (signed.status !== 200 || !signed.body.includes("accepted")) {
  console.error("FAIL: signed event was not accepted.");
  process.exit(1);
}

// 2. Identical replay must be deduplicated by event_id.
const replay = await post(
  { "svix-id": event.event_id, "svix-timestamp": timestamp, "svix-signature": signature },
  "replay",
);
console.log(`[${replay.label}] HTTP ${replay.status} ${replay.body}`);
if (!replay.body.includes("duplicate_ignored")) {
  console.error("FAIL: replay was not deduplicated.");
  process.exit(1);
}

// 3. A tampered payload must be rejected.
const tampered = await post(
  { "svix-id": "tampered-id", "svix-timestamp": timestamp, "svix-signature": "v1,badsignature" },
  "tampered",
);
console.log(`[${tampered.label}] HTTP ${tampered.status} ${tampered.body}`);
if (tampered.status !== 401) {
  console.error("FAIL: tampered signature was not rejected with 401.");
  process.exit(1);
}

console.log("\nPASS: signature verified, ingest accepted, replay deduped, tampering rejected.");
