import { httpRouter } from "convex/server";
import { verifyAgentMailWebhook } from "@agentmail/convex";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { api, components } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

/**
 * AgentMail webhook:
 * 1. verified in this V8 runtime with the component's own svix verifier,
 * 2. forwarded into the official component's deduped `handleEvent` ingest, then
 * 3. recorded in app-owned inbox/outcome tables (idempotent by event_id).
 */
const agentmailWebhook = httpAction(async (ctx, request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const rawBody = await request.text();
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? "";
  // Svix signs with either the classic svix-* or the standard webhook-* header
  // prefix; accept both so real provider events never fail on naming.
  const headerValue = (name: string) =>
    request.headers.get(`svix-${name}`) ?? request.headers.get(`webhook-${name}`) ?? "";
  const headers = {
    "svix-id": headerValue("id"),
    "svix-timestamp": headerValue("timestamp"),
    "svix-signature": headerValue("signature"),
  };
  if (!secret) return new Response("AGENTMAIL_WEBHOOK_SECRET is not configured", { status: 500 });

  let event: Record<string, unknown>;
  try {
    event = verifyAgentMailWebhook(secret, rawBody, headers) as Record<string, unknown>;
  } catch {
    return new Response("Invalid webhook signature", { status: 401 });
  }
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  const eventId = typeof event.event_id === "string" ? event.event_id : "";
  if (!eventType || !eventId) {
    return new Response("Webhook payload is missing event identity", { status: 400 });
  }

  // Normalize message field naming before component ingest: the component's
  // schema requires `message.from` + array `to`, while some AgentMail payloads
  // use `from_`. Our app-side ingest accepts both spellings.
  const message = isRecord(event.message) ? event.message : null;
  if (message) {
    if (typeof message.from !== "string") {
      const fromArray = Array.isArray(message.from_) ? message.from_ : [];
      message.from = typeof message.from_ === "string"
        ? message.from_
        : typeof fromArray[0] === "string" ? fromArray[0] : "unknown";
    }
    if (!Array.isArray(message.to)) message.to = [];
  }

  // Durable component ingest: dedupes by event_id and dispatches configured callbacks.
  await ctx.runMutation(components.agentmail.lib.handleEvent, {
    config: { retryAttempts: 5, initialBackoffMs: 30000 },
    event: event as never,
  });

  const { accepted } = await ctx.runMutation(api.inbox.ingestEvent, {
    eventId,
    eventType,
    message: event.message ?? null,
    thread: event.thread ?? null,
    send: event.send ?? null,
    delivery: event.delivery ?? null,
    bounce: event.bounce ?? null,
    reject: event.reject ?? null,
    complaint: event.complaint ?? null,
  });

  return new Response(JSON.stringify({ status: accepted ? "accepted" : "duplicate_ignored" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

http.route({ path: "/agentmail/webhook", method: "POST", handler: agentmailWebhook });

// Firecrawl crawl progress webhooks are mounted automatically at /firecrawl/webhook
// by convex.config.ts (httpPrefix: "/firecrawl/").

// Static hosting catch-all: registered AFTER exact app routes so /agentmail/webhook
// and /firecrawl/* keep priority; everything else serves the built frontend.
registerStaticRoutes(http, components.staticHosting);

export default http;
