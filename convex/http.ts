import { httpRouter } from "convex/server";
import { verifyAgentMailWebhook } from "@agentmail/convex";
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
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
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

http.route({ path: "/agentmail/webhook", method: "POST", handler: agentmailWebhook });

// Firecrawl crawl progress webhooks are mounted automatically at /firecrawl/webhook
// by convex.config.ts (httpPrefix: "/firecrawl/").

export default http;
