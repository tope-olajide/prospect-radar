import { defineComponent } from "convex/server";
import { v } from "convex/values";
import workpool from "@convex-dev/workpool/convex.config";

/**
 * Vendored from `@agentmail/convex@0.1.0` (src/component) — see README.md in
 * this directory for why. Mounted by `convex/convex.config.ts`.
 *
 * Env is declared (rather than inherited) so the parent app can forward the
 * AgentMail credentials in: the component reads them from its own environment
 * (`utils.ts`), and Convex only exposes env vars a component declares.
 */
const component = defineComponent("agentmail", {
  env: {
    AGENTMAIL_API_KEY: v.optional(v.string()),
    AGENTMAIL_BASE_URL: v.optional(v.string()),
    AGENTMAIL_WEBHOOK_SECRET: v.optional(v.string()),
  },
});

component.use(workpool, { name: "sendPool" });
component.use(workpool, { name: "callbackPool" });

export default component;
