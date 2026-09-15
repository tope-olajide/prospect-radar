"use node";

import process from "node:process";
import { Webhook } from "svix";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const verifyEvent = internalAction({
  args: {
    rawBody: v.string(),
    svixId: v.string(),
    svixTimestamp: v.string(),
    svixSignature: v.string(),
  },
  returns: v.any(),
  handler: async (_ctx, args) => {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret) throw new Error("AGENTMAIL_WEBHOOK_SECRET is not configured on this Convex deployment.");
    const verifier = new Webhook(secret);
    const payload = verifier.verify(args.rawBody, {
      "svix-id": args.svixId,
      "svix-timestamp": args.svixTimestamp,
      "svix-signature": args.svixSignature,
    });
    return JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
  },
});
