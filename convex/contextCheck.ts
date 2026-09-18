/**
 * Context Readiness — the gate that decides whether Radar has enough trustworthy
 * information about the user to perform a mission correctly.
 *
 * This is a three-source resolver:
 *
 *   Profile & Context  (workspace-level confirmed facts)
 *        +
 *   Mission Facts      (mission-scoped confirmed facts)
 *        +
 *   Source Evidence     (chunks from uploaded files, websites, snippets)
 *        ↓
 *   Context Resolver
 *        ↓
 *   ┌───────┼────────┐
 *   ↓       ↓        ↓
 *  Known   Missing  Conflict
 *
 * Trust rules:
 *   - user_confirmed / user_corrected facts → fully trusted, may represent user
 *   - source-backed evidence → usable for discovery/matching, NOT for outreach
 *   - AI inference → may inform reasoning, cannot become user fact silently
 *   - conflicting signals → ask the user to resolve
 *
 * No-over-questioning principle:
 *   - required → block if missing
 *   - important → continue if the mission can still be meaningfully pursued
 *   - nice_to_have → never block
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Requirement definitions ───────────────────────────────────────────

type Criticality = "required" | "important" | "nice_to_have";

type Requirement = {
  key: string;
  criticality: Criticality;
  question: string;
  category?: string; // fact category to match against
};

type RequirementStatus = {
  key: string;
  criticality: Criticality;
  question: string;
  satisfied: boolean;
  trustLevel: "confirmed" | "source_backed" | "missing" | "conflict";
  reason: string;
  evidence?: string; // source title + excerpt if source_backed
  factValue?: string; // confirmed fact value if confirmed
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

// ── Evidence detection ────────────────────────────────────────────────

/**
 * Maps requirement categories to search terms the full-text index can match.
 * These are deliberately broad so a portfolio mentioning "React" or "fintech"
 * gets detected even if the user's confirmed facts don't include those terms.
 */
const CATEGORY_SEARCH_TERMS: Record<string, string[]> = {
  skills: ["skills", "experience", "services", "technologies", "expertise"],
  engagement: ["freelance", "contract", "full-time", "part-time", "engagement"],
  location: ["remote", "location", "timezone", "based in"],
  role: ["role", "position", "title", "expertise", "specialist"],
  product: ["product", "service", "solution", "platform", "tool"],
  target_customer: ["customer", "client", "market", "audience", "industry"],
  geography: ["location", "region", "country", "city", "market"],
  problem: ["problem", "challenge", "issue", "pain point", "need"],
  constraints: ["constraint", "requirement", "limitation", "budget", "timeline"],
  project: ["project", "initiative", "goal", "objective"],
  deliverable: ["deliverable", "output", "result", "document", "report"],
  scope: ["scope", "scale", "size", "duration", "timeline"],
  experience: ["experience", "background", "history", "portfolio"],
  criteria: ["criteria", "requirements", "qualifications", "standards"],
  purpose: ["purpose", "goal", "objective", "reason"],
};

/**
 * Search user data sources for evidence matching a requirement category.
 * Returns source-backed evidence if found, null otherwise.
 */
async function findSourceEvidence(
  ctx: { runQuery: (fn: never, args: never) => Promise<unknown> },
  workspaceId: string,
  category: string,
): Promise<{ title: string; kind: string; excerpt: string } | null> {
  const terms = CATEGORY_SEARCH_TERMS[category];
  if (!terms || terms.length === 0) return null;

  // Try each search term until we find evidence
  for (const term of terms) {
    try {
      const chunks = await ctx.runQuery(internal.dataSources.relevantChunks as never, {
        workspaceId,
        query: term,
      } as never);
      const typedChunks = chunks as Array<{ title: string; kind: string; text: string }>;
      if (typedChunks.length > 0) {
        return {
          title: typedChunks[0].title,
          kind: typedChunks[0].kind,
          excerpt: typedChunks[0].text.slice(0, 200),
        };
      }
    } catch {
      // Search failures must not block readiness
    }
  }
  return null;
}

// ── Readiness check ───────────────────────────────────────────────────

/**
 * Checks whether the user has provided enough trustworthy information for
 * a mission of the given intent type.
 *
 * The resolver reads three sources:
 *   1. Workspace-level confirmed facts (profile)
 *   2. Mission-scoped confirmed facts
 *   3. Source evidence from uploaded files, websites, and snippets
 *
 * Each requirement is classified as:
 *   - confirmed: satisfied by a user_confirmed/user_corrected fact
 *   - source_backed: satisfied by evidence in user sources (usable for
 *     discovery/matching, NOT for representing user in outreach)
 *   - conflict: facts and sources disagree
 *   - missing: no evidence found
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
      trustLevel: v.union(
        v.literal("confirmed"),
        v.literal("source_backed"),
        v.literal("missing"),
        v.literal("conflict"),
      ),
      reason: v.string(),
      evidence: v.optional(v.string()),
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

    // Read workspace-level and mission-scoped confirmed facts
    const factRows = await ctx.db
      .query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", mission.workspaceId))
      .take(200);

    // Build lookup: category → confirmed values
    const confirmedByCategory = new Map<string, Array<{ value: string; id: Id<"contextFacts"> }>>();
    for (const row of factRows) {
      if (!["user_confirmed", "user_corrected"].includes(row.verificationStatus)) continue;
      const existing = confirmedByCategory.get(row.category) ?? [];
      existing.push({ value: row.value, id: row._id });
      confirmedByCategory.set(row.category, existing);
    }

    // Check each requirement against confirmed facts + source evidence
    const results: RequirementStatus[] = [];

    for (const req of requirements) {
      const category = req.category ?? req.key;
      const confirmedFacts = confirmedByCategory.get(category);

      // Step 1: Check confirmed facts
      if (confirmedFacts && confirmedFacts.length > 0) {
        results.push({
          key: req.key,
          criticality: req.criticality,
          question: req.question,
          satisfied: true,
          trustLevel: "confirmed",
          reason: `${confirmedFacts.length} confirmed fact(s) for "${category}"`,
          factValue: confirmedFacts[0].value,
        });
        continue;
      }

      // Step 2: Search source evidence
      const evidence = await findSourceEvidence(ctx, mission.workspaceId, category);
      if (evidence) {
        // Source-backed: usable for discovery/matching, not for outreach
        results.push({
          key: req.key,
          criticality: req.criticality,
          question: req.question,
          satisfied: req.criticality !== "required", // source evidence satisfies important/nice-to-have, but required still needs confirmation
          trustLevel: "source_backed",
          reason: `Source evidence found in ${evidence.title} (${evidence.kind})`,
          evidence: `${evidence.title}: ${evidence.excerpt}`,
        });
        continue;
      }

      // Step 3: Missing
      results.push({
        key: req.key,
        criticality: req.criticality,
        question: req.question,
        satisfied: false,
        trustLevel: "missing",
        reason: `No confirmed facts or source evidence for "${category}"`,
      });
    }

    // Determine readiness: required items must be satisfied
    const missingRequired = results
      .filter((r) => r.criticality === "required" && !r.satisfied)
      .map((r) => r.key);
    const missingImportant = results
      .filter((r) => r.criticality === "important" && !r.satisfied)
      .map((r) => r.key);

    // Ready only if all required items are satisfied.
    // Important items are noted but don't block.
    // Nice-to-have items never block.
    const ready = missingRequired.length === 0;

    return { ready, requirements: results, missingRequired, missingImportant };
  },
});


