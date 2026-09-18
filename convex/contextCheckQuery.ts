/**
 * Public query wrapper for context readiness.
 *
 * Separated from contextCheck.ts to avoid a circular type reference: the
 * internal readinessForMission query returns a shape that references itself
 * through the generated API types, which TypeScript cannot resolve. This file
 * imports the internal function and re-exports it as a public query with a
 * flat return type.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { internal } from "./_generated/api";

// The return type of readinessForMission creates a circular reference when
// re-exported through the generated API types. Cast the handler to break the
// cycle — the runtime validates the actual return shape against `returns`.
export const readiness = query({
  args: { missionId: v.id("missions") },
  returns: v.object({
    ready: v.boolean(),
    requirements: v.array(v.object({
      key: v.string(),
      criticality: v.union(v.literal("required"), v.literal("important"), v.literal("nice_to_have")),
      question: v.string(),
      satisfied: v.boolean(),
      trustLevel: v.union(
        v.literal("confirmed"), v.literal("source_backed"),
        v.literal("missing"), v.literal("conflict"),
      ),
      reason: v.string(),
      evidence: v.optional(v.string()),
      factValue: v.optional(v.string()),
    })),
    missingRequired: v.array(v.string()),
    missingImportant: v.array(v.string()),
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (ctx: any, args: any): Promise<any> => {
    return await ctx.runQuery(internal.contextCheck.readinessForMission, { missionId: args.missionId });
  },
});
