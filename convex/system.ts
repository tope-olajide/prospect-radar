import { v } from "convex/values";
import { query } from "./_generated/server";

export const status = query({
  args: {},
  returns: v.object({
    name: v.string(),
    status: v.literal("ready"),
  }),
  handler: async () => ({
    name: "Prospect Radar",
    status: "ready" as const,
  }),
});
