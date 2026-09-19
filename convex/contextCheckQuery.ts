/**
 * Public query wrapper for context readiness.
 *
 * Kept separate from contextCheck.ts because the internal query's return type
 * references the generated API types through its own module — inferring it here
 * would close a cycle. The shape is declared once below as a validator, and the
 * handler is annotated with the type inferred *from that validator* rather than
 * from the other module, which breaks the cycle and gives the frontend a real
 * type to render against.
 */

import { v, type Infer } from "convex/values";
import { query } from "./_generated/server";
import { internal } from "./_generated/api";

const contextRequirement = v.object({
  key: v.string(),
  criticality: v.union(v.literal("required"), v.literal("important"), v.literal("nice_to_have")),
  why: v.string(),
  question: v.string(),
  satisfied: v.boolean(),
  /** May Radar represent the user with this, or only research with it? */
  authorized: v.boolean(),
  trustLevel: v.union(
    v.literal("confirmed"), v.literal("source_backed"),
    v.literal("missing"), v.literal("conflict"),
  ),
  reason: v.string(),
  factValue: v.union(v.string(), v.null()),
  evidence: v.union(v.string(), v.null()),
  conflictValues: v.union(
    v.array(v.object({ value: v.string(), origin: v.string() })),
    v.null(),
  ),
  /** Confirmed facts this answer would overrule, when settling a conflict. */
  supersedes: v.union(v.array(v.id("contextFacts")), v.null()),
  artifactLabel: v.union(v.string(), v.null()),
  artifactKinds: v.union(v.array(v.string()), v.null()),
});

const readinessResult = v.object({
  ready: v.boolean(),
  requirements: v.array(contextRequirement),
  blocking: v.array(v.string()),
  missingRequired: v.array(v.string()),
  missingImportant: v.array(v.string()),
  unauthorized: v.array(v.string()),
  conflictCount: v.number(),
});

export type ContextRequirementStatus = Infer<typeof contextRequirement>;
export type MissionReadiness = Infer<typeof readinessResult>;

export const readiness = query({
  args: { missionId: v.id("missions") },
  returns: readinessResult,
  handler: async (ctx, args): Promise<MissionReadiness> => {
    // The internal resolver returns the same shape; it is validated by `returns`.
    return (await ctx.runQuery(internal.contextCheck.readinessForMission, {
      missionId: args.missionId,
    })) as unknown as MissionReadiness;
  },
});
