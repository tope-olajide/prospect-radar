import { httpRouter } from "convex/server";
import { agentmailWebhook } from "./inbox";

const http = httpRouter();

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: agentmailWebhook,
});

export default http;
