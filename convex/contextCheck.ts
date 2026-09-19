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
 *   Source Evidence     (evidence excerpts from uploaded files, websites, snippets)
 *        ↓
 *   Context Resolver
 *        ↓
 *   ┌───────┼────────┐
 *   ↓       ↓        ↓
 *  Known   Missing  Conflict
 *
 * Trust rules — note that "usable" and "authorized" are different things:
 *   - confirmed facts (user_confirmed / user_corrected) → authorized. Radar may
 *     represent the user with them in outreach, forms, proposals.
 *   - source-backed evidence → may inform discovery and matching, but is NOT
 *     authorized to represent the user. It never silently becomes a fact.
 *   - conflict → the user's own evidence disagrees with a confirmed fact. Radar
 *     stops and asks rather than picking a side.
 *
 * No-over-questioning principle:
 *   - required     → blocks while missing
 *   - important    → never blocks; shown as optional
 *   - nice_to_have → never blocks, never asked
 *   - declared conflicts block at required and important (a consequential action
 *     must not rest on contradictory information), but never at nice_to_have.
 *
 * The retrieval layer behind this is deliberately thin: a probe-term scan over
 * the user's own chunks, plus two conservative conflict rules. A requirement is
 * modelled as "what evidence would satisfy this?" — so the probe list and the
 * trust rules can be replaced by semantic evaluation without changing the
 * readiness contract the orchestrator depends on.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirementsForIntent, type Criticality, type Requirement } from "./contextRequirements";

// ── Types ─────────────────────────────────────────────────────────────

type TrustLevel = "confirmed" | "source_backed" | "missing" | "conflict";

type TrustedFact = { value: string; id: Id<"contextFacts"> };

type EvidenceHit = { term: string; title: string; kind: string; excerpt: string };

type RequirementStatus = {
  key: string;
  criticality: Criticality;
  why: string;
  question: string;
  satisfied: boolean;
  /** May Radar represent the user with this, or only use it internally? */
  authorized: boolean;
  trustLevel: TrustLevel;
  reason: string;
  factValue: string | null;
  evidence: string | null;
  conflictValues: Array<{ value: string; origin: string }> | null;
  /** Confirmed facts this answer would overrule, when resolving a conflict. */
  supersedes: Id<"contextFacts">[] | null;
  artifactLabel: string | null;
  artifactKinds: string[] | null;
};

// ── Evidence probes ───────────────────────────────────────────────────
//
// Ordered most-specific first: the first probe to hit a chunk claims it, so a
// precise term ("contractor") outranks a broad one ("services").
//
// These lists are a retrieval strategy, not the intelligence layer. They exist
// so the resolver can ask "is there any of the user's own material that bears on
// this requirement?" and nothing more — the resolution decision above them
// (satisfied / source_backed / missing / conflict) is what the rest of the
// system depends on.

const CATEGORY_SEARCH_TERMS: Record<string, string[]> = {
  skills: ["skills", "technologies", "services", "expertise", "experience"],
  engagement: ["contractor", "freelance", "contract", "full-time", "part-time", "engagement"],
  location: ["remote", "timezone", "based in", "location"],
  role: ["specialist", "expertise", "title", "position", "role"],
  product: ["platform", "solution", "product", "service"],
  target_customer: ["audience", "market", "customer", "client", "industry"],
  problem: ["pain point", "challenge", "problem", "issue"],
  constraints: ["constraint", "requirement", "limitation", "budget", "timeline"],
  project: ["project", "initiative", "objective"],
  deliverable: ["deliverable", "output", "report", "document"],
  scope: ["scope", "duration", "timeline", "scale"],
  experience: ["portfolio", "background", "case study", "experience"],
  criteria: ["qualifications", "standards", "criteria", "requirements"],
  purpose: ["objective", "purpose", "reason", "goal"],
};

// ── Conflict detection ────────────────────────────────────────────────
//
// Two conservative rules, both of which require a *semantic* disagreement
// rather than merely different levels of detail. "React" in a profile and
// "React + Next.js" in a portfolio is enrichment, and must not be reported as a
// conflict; "full-time" in a profile and "only contract" in a portfolio is a
// contradiction the user has to settle.

const EXCLUSIVE_AXES: Record<string, Array<{ axis: string; values: Record<string, string[]> }>> = {
  engagement: [
    {
      axis: "engagement type",
      values: {
        "full-time": ["full-time", "full time", "fulltime"],
        contract: ["contract", "contracting", "contractor"],
        freelance: ["freelance", "freelancing"],
        "part-time": ["part-time", "part time"],
      },
    },
  ],
  location: [
    {
      axis: "work location",
      values: {
        remote: ["remote"],
        "on-site": ["on-site", "onsite", "in-office", "in office"],
        hybrid: ["hybrid"],
      },
    },
  ],
};

/** Marks a value as the *only* acceptable one, which is what creates a clash. */
const EXCLUSIVITY = /\b(?:only|exclusively|solely|primarily|instead of|no longer)\b/;
const NEGATION_CUES = "(?:not|never|without|cannot|can't|isn't|aren't|doesn't|don't|didn't|lacks?|lack of)";

/** Words too generic to carry a contradiction on their own. */
const WEAK_TERMS = new Set([
  "available", "currently", "looking", "seeking", "open", "prefer", "preference",
  "want", "wanting", "need", "role", "roles", "type", "types", "work", "working",
  "with", "from", "that", "this", "your", "have", "full", "time", "part", "based",
  "anywhere", "only", "also", "well", "good", "great",
]);

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function significantTerms(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => word.length >= 4 && !WEAK_TERMS.has(word) && !/^\d+$/.test(word)),
  )];
}

function mentionsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function pickAxisValue(values: Record<string, string[]>, text: string): string | null {
  for (const [value, terms] of Object.entries(values)) {
    if (mentionsAny(text, terms)) return value;
  }
  return null;
}

/**
 * Rule 1 — two different, mutually exclusive values on the same axis.
 *
 * Requires an exclusivity marker on at least one side, so "open to full-time or
 * contract" against "contract work" is compatible rather than contradictory.
 */
function findAxisConflict(
  category: string,
  factValue: string,
  excerpt: string,
): { axis: string; factValue: string; evidenceValue: string } | null {
  const axes = EXCLUSIVE_AXES[category];
  if (!axes) return null;
  const fact = factValue.toLowerCase();
  const evidence = excerpt.toLowerCase();

  for (const { axis, values } of axes) {
    const factPick = pickAxisValue(values, fact);
    const evidencePick = pickAxisValue(values, evidence);
    if (!factPick || !evidencePick || factPick === evidencePick) continue;
    // The fact already allows the source's value, so the two agree.
    if (mentionsAny(fact, values[evidencePick])) continue;
    if (!EXCLUSIVITY.test(fact) && !EXCLUSIVITY.test(evidence)) continue;
    return { axis, factValue: factPick, evidenceValue: evidencePick };
  }
  return null;
}

/**
 * Rule 2 — the source explicitly negates something the user confirmed.
 *
 * Only explicit negations count. A bare "no" is allowed at most one intervening
 * word, so "no React experience" is a conflict but "no doubt about React" is not.
 */
function findNegation(factValue: string, excerpt: string): string | null {
  const haystack = excerpt.toLowerCase();
  for (const term of significantTerms(factValue)) {
    const escaped = escapeRe(term);
    const patterns = [
      new RegExp(`\\b${NEGATION_CUES}\\b[^.\\n]{0,40}?\\b${escaped}\\b`),
      new RegExp(`\\bno\\s+(?:\\w+\\s+){0,1}${escaped}\\b`),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(haystack);
      if (match) return match[0].trim();
    }
  }
  return null;
}

// ── Resolution ────────────────────────────────────────────────────────

const EMPTY_TAIL = {
  factValue: null,
  evidence: null,
  conflictValues: null,
  supersedes: null,
  artifactLabel: null,
  artifactKinds: null,
} as const;

function resolveRequirement(
  req: Requirement,
  facts: TrustedFact[],
  evidence: EvidenceHit[],
): RequirementStatus {
  const acceptable = req.acceptableTrust ?? ["confirmed"];
  const base = { key: req.key, criticality: req.criticality, why: req.why };

  // 1. Conflict — the user's own material disagrees with a confirmed fact.
  if (facts.length > 0 && evidence.length > 0) {
    for (const fact of facts) {
      for (const hit of evidence) {
        const axis = findAxisConflict(req.category, fact.value, hit.excerpt);
        const negation = axis ? null : findNegation(fact.value, hit.excerpt);
        if (!axis && !negation) continue;
        return {
          ...base,
          question: axis
            ? `Your profile says "${fact.value}", but ${hit.title} suggests "${axis.evidenceValue}". Which should Radar use?`
            : `Your profile says "${fact.value}", but ${hit.title} appears to contradict it. What should Radar use?`,
          satisfied: false,
          authorized: false,
          trustLevel: "conflict",
          reason: axis
            ? `Your profile and ${hit.title} disagree about ${axis.axis}`
            : `${hit.title} reads "${negation}"`,
          factValue: fact.value,
          evidence: `${hit.title}: ${hit.excerpt}`,
          // Only a clean pair of labels can be offered as a choice. A negation
          // is answered by saying what is true, so it falls back to a free-text
          // answer rather than letting prose become a fact value.
          conflictValues: axis
            ? [
              { value: fact.value, origin: "your profile" },
              { value: axis.evidenceValue, origin: hit.title },
            ]
            : null,
          supersedes: facts.map((f) => f.id),
          artifactLabel: null,
          artifactKinds: null,
        };
      }
    }
  }

  // 2. A confirmed fact the user controls.
  if (facts.length > 0 && acceptable.includes("confirmed")) {
    return {
      ...base,
      question: req.question,
      satisfied: true,
      authorized: true,
      trustLevel: "confirmed",
      reason: facts.length === 1 ? "Confirmed by you" : `${facts.length} confirmed facts`,
      factValue: facts[0].value,
      evidence: null,
      conflictValues: null,
      supersedes: null,
      artifactLabel: null,
      artifactKinds: null,
    };
  }

  // 3. Evidence from the user's own sources.
  if (evidence.length > 0) {
    const accepted = acceptable.includes("source_backed");
    const hit = evidence[0];
    return {
      ...base,
      question: req.question,
      satisfied: accepted,
      // Even when it satisfies the requirement, evidence is not a claim the
      // user has made — it may inform research but not represent them.
      authorized: false,
      trustLevel: "source_backed",
      reason: accepted
        ? `Found in ${hit.title} — usable for research and matching; Radar will not state it as your claim`
        : `Found in ${hit.title}, but Radar needs you to confirm it before relying on it`,
      factValue: null,
      evidence: `${hit.title}: ${hit.excerpt}`,
      conflictValues: null,
      supersedes: null,
      artifactLabel: null,
      artifactKinds: null,
    };
  }

  // 4. Nothing anywhere — ask, or ask for the artifact that would answer it.
  return {
    ...base,
    question: req.question,
    satisfied: false,
    authorized: false,
    trustLevel: "missing",
    reason: `Nothing in your profile or sources covers "${req.category}"`,
    ...EMPTY_TAIL,
    artifactLabel: req.artifact?.label ?? null,
    artifactKinds: req.artifact?.kinds ?? null,
  };
}

/** Blocks while missing at `required`; blocks on a declared conflict unless trivial. */
function isBlocking(status: RequirementStatus): boolean {
  if (status.trustLevel === "conflict") return status.criticality !== "nice_to_have";
  if (status.trustLevel !== "missing") return false;
  return status.criticality === "required";
}

// ── Readiness check ───────────────────────────────────────────────────

export const readinessForMission = internalQuery({
  args: { missionId: v.id("missions") },
  returns: v.object({
    ready: v.boolean(),
    requirements: v.array(v.object({
      key: v.string(),
      criticality: v.union(v.literal("required"), v.literal("important"), v.literal("nice_to_have")),
      why: v.string(),
      question: v.string(),
      satisfied: v.boolean(),
      authorized: v.boolean(),
      trustLevel: v.union(
        v.literal("confirmed"),
        v.literal("source_backed"),
        v.literal("missing"),
        v.literal("conflict"),
      ),
      reason: v.string(),
      factValue: v.union(v.string(), v.null()),
      evidence: v.union(v.string(), v.null()),
      conflictValues: v.union(
        v.array(v.object({ value: v.string(), origin: v.string() })),
        v.null(),
      ),
      supersedes: v.union(v.array(v.id("contextFacts")), v.null()),
      artifactLabel: v.union(v.string(), v.null()),
      artifactKinds: v.union(v.array(v.string()), v.null()),
    })),
    blocking: v.array(v.string()),
    missingRequired: v.array(v.string()),
    missingImportant: v.array(v.string()),
    /** Satisfied by evidence only — usable to research, not to represent the user. */
    unauthorized: v.array(v.string()),
    conflictCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const empty = {
      ready: false, requirements: [] as RequirementStatus[], blocking: [] as string[],
      missingRequired: [] as string[], missingImportant: [] as string[],
      unauthorized: [] as string[], conflictCount: 0,
    };
    const mission = await ctx.db.get(args.missionId);
    if (!mission) return empty;

    const intentKey = mission.intent?.primary ?? mission.mode;
    const requirements = requirementsForIntent(intentKey);
    if (requirements.length === 0) return { ...empty, ready: true };

    // Confirmed facts only. Unreviewed and rejected rows are deliberately absent:
    // an inference or a rejection must never satisfy a requirement.
    const factRows = await ctx.db
      .query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", mission.workspaceId))
      .take(200);

    const confirmedByCategory = new Map<string, TrustedFact[]>();
    for (const row of factRows) {
      if (!["user_confirmed", "user_corrected"].includes(row.verificationStatus)) continue;
      const existing = confirmedByCategory.get(row.category) ?? [];
      existing.push({ value: row.value, id: row._id });
      confirmedByCategory.set(row.category, existing);
    }

    // One evidence scan covers every requirement. Probe terms are ordered
    // most-specific first across all categories.
    const probeTerms: string[] = [];
    for (const req of requirements) {
      for (const term of CATEGORY_SEARCH_TERMS[req.category] ?? []) {
        if (!probeTerms.includes(term)) probeTerms.push(term);
      }
    }
    let hits: EvidenceHit[] = [];
    if (probeTerms.length > 0) {
      try {
        hits = await ctx.runQuery(internal.dataSources.evidenceForTerms, {
          workspaceId: mission.workspaceId,
          terms: probeTerms,
        });
      } catch {
        hits = []; // evidence retrieval must never block a readiness check
      }
    }
    const evidenceByCategory = new Map<string, EvidenceHit[]>();
    for (const req of requirements) {
      const owned = hits.filter((hit) => (CATEGORY_SEARCH_TERMS[req.category] ?? []).includes(hit.term));
      if (owned.length > 0) evidenceByCategory.set(req.category, owned);
    }

    const results = requirements.map((req) =>
      resolveRequirement(req, confirmedByCategory.get(req.category) ?? [], evidenceByCategory.get(req.category) ?? []),
    );

    const blocking = results.filter(isBlocking).map((r) => r.key);
    return {
      ready: blocking.length === 0,
      requirements: results,
      blocking,
      missingRequired: results.filter((r) => r.criticality === "required" && r.trustLevel === "missing").map((r) => r.key),
      missingImportant: results.filter((r) => r.criticality === "important" && r.trustLevel === "missing").map((r) => r.key),
      unauthorized: results.filter((r) => r.satisfied && !r.authorized).map((r) => r.key),
      conflictCount: results.filter((r) => r.trustLevel === "conflict").length,
    };
  },
});
