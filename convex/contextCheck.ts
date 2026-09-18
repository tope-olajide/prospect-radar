/**
 * Context Readiness — the gate that decides whether Radar has enough trustworthy
 * information about the user to perform a mission correctly.
 *
 * Without this, Radar either guesses (bad) or blocks every mission (also bad).
 * The intended flow is:
 *
 *   user goal → interpret → context_check → [plan | ask user] → plan → ...
 *
 * Each intent defines what information is actually necessary to accomplish the
 * mission. The check reads the user's profile, workspace-level context, and
 * mission-scoped facts, then decides whether the requirements are satisfied.
 *
 * Critical rules:
 *   - Never invent missing information
 *   - Ask only for what is actually required
 *   - Distinguish source-backed facts from AI inferences
 *   - A requirement can be satisfied by profile facts, mission facts, or
 *     source-backed evidence, depending on what the intent needs
 *   - The user's answer becomes a persisted, confirmed fact — not appended
 *     to the raw goal
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

// ── Requirement definitions ───────────────────────────────────────────

const requirement = v.object({
  key: v.string(),
  criticality: v.union(
    v.literal("required"),
    v.literal("important"),
    v.literal("nice_to_have"),
  ),
  question: v.string(),
  category: v.optional(v.string()), // where to persist the answer as a fact
});

type Requirement = {
  key: string;
  criticality: "required" | "important" | "nice_to_have";
  question: string;
  category?: string;
};

type RequirementStatus = {
  key: string;
  criticality: Requirement["criticality"];
  question: string;
  satisfied: boolean;
  reason: string; // why satisfied or what is missing
  factId?: Id<"contextFacts">; // the fact that satisfies it, if any
};

// ── Per-intent requirements ───────────────────────────────────────────

const REQUIREMENTS: Record<string, Requirement[]> = {
  find_opportunity: [
    { key: "skills", criticality: "required", question: "What skills or services do you offer?", category: "skills" },
    { key: "engagement_type", criticality: "important", question: "What type of engagement are you looking for? (e.g. contract, full-time, freelance, project-based)", category: "engagement" },
    { key: "location_preference", criticality: "nice_to_have", question: "Do you have a location or timezone preference?", category: "location" },
  ],
  find_person: [
    { key: "role_description", criticality: "required", question: "What role or expertise are you looking for?", category: "role" },
    { key: "engagement_type", criticality: "important", question: "What type of engagement? (e.g. contract, full-time, collaboration)", category: "engagement" },
  ],
  find_customer: [
    { key: "product_description", criticality: "required", question: "What does your product or service do?", category: "product" },
    { key: "target_customer", criticality: "required", question: "Who is your ideal customer?", category: "target_customer" },
    { key: "geography", criticality: "important", question: "Do you have a target geography?", category: "location" },
  ],
  find_solution: [
    { key: "problem_description", criticality: "required", question: "What problem are you trying to solve?", category: "problem" },
    { key: "constraints", criticality: "important", question: "What constraints or requirements do you have?", category: "constraints" },
  ],
  find_collaborator: [
    { key: "project_description", criticality: "required", question: "What is the project about?", category: "project" },
    { key: "user_contribution", criticality: "required", question: "What are you bringing to the collaboration?", category: "skills" },
    { key: "required_expertise", criticality: "required", question: "What expertise do you need from the collaborator?", category: "role" },
  ],
  find_service: [
    { key: "deliverable", criticality: "required", question: "What deliverable do you need?", category: "deliverable" },
    { key: "scope", criticality: "important", question: "What is the scope of the work?", category: "scope" },
  ],
  find_client: [
    { key: "services", criticality: "required", question: "What services do you offer?", category: "skills" },
    { key: "ideal_client", criticality: "important", question: "What does your ideal client look like?", category: "target_customer" },
    { key: "experience", criticality: "nice_to_have", question: "What relevant experience do you have?", category: "experience" },
  ],
  find_provider: [
    { key: "what_needed", criticality: "required", question: "What service or capability do you need?", category: "deliverable" },
    { key: "scope", criticality: "important", question: "What is the scope and timeline?", category: "scope" },
  ],
  find_business: [
    { key: "criteria", criticality: "required", question: "What criteria should Radar use to find businesses?", category: "criteria" },
    { key: "purpose", criticality: "important", question: "What is the purpose of finding these businesses?", category: "purpose" },
  ],
};

// ── Readiness check ───────────────────────────────────────────────────

/**
 * Checks whether the user has provided enough trustworthy information for
 * a mission of the given intent type.
 *
 * Returns the full list of requirements with their satisfaction status,
 * plus a summary of whether the mission is ready to proceed.
 */
export const readinessForMission = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.object({
    ready: v.boolean(),
    requirements: v.array(v.object({
      key: v.string(),
      criticality: v.union(v.literal("required"), v.literal("important"), v.literal("nice_to_have")),
      question: v.string(),
      satisfied: v.boolean(),
      reason: v.string(),
      factValue: v.optional(v.string()),
    })),
    missingRequired: v.array(v.string()),
    missingImportant: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) {
      return { ready: false, requirements: [], missingRequired: [], missingImportant: [] };
    }

    const intentKey = mission.intent?.primary ?? mission.mode;
    const requirements = REQUIREMENTS[intentKey] ?? [];

    // Read the user's workspace-level and mission-scoped facts
    const factRows = await ctx.db
      .query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", mission.workspaceId))
      .take(200);

    // Build a lookup: category → values (only user_confirmed or user_corrected facts)
    const factByCategory = new Map<string, Array<{ value: string; status: string; id: Id<"contextFacts"> }>>();
    for (const row of factRows) {
      if (!["user_confirmed", "user_corrected"].includes(row.verificationStatus)) continue;
      const existing = factByCategory.get(row.category) ?? [];
      existing.push({ value: row.value, status: row.verificationStatus, id: row._id });
      factByCategory.set(row.category, existing);
    }

    // Check each requirement
    const results: Array<{
      key: string;
      criticality: Requirement["criticality"];
      question: string;
      satisfied: boolean;
      reason: string;
      factValue?: string;
    }> = [];

    for (const req of requirements) {
      const facts = factByCategory.get(req.category ?? "");
      if (facts && facts.length > 0) {
        results.push({
          key: req.key,
          criticality: req.criticality,
          question: req.question,
          satisfied: true,
          reason: `${facts.length} confirmed fact(s) for "${req.category}"`,
          factValue: facts[0].value,
        });
      } else {
        results.push({
          key: req.key,
          criticality: req.criticality,
          question: req.question,
          satisfied: false,
          reason: `No confirmed facts for "${req.category ?? req.key}"`,
        });
      }
    }

    const missingRequired = results
      .filter((r) => r.criticality === "required" && !r.satisfied)
      .map((r) => r.key);
    const missingImportant = results
      .filter((r) => r.criticality === "important" && !r.satisfied)
      .map((r) => r.key);

    // Ready only if all required items are satisfied
    const ready = missingRequired.length === 0;

    return { ready, requirements: results, missingRequired, missingImportant };
  },
});
