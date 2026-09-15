import { v } from "convex/values";

/**
 * Intent ontology for Prospect Radar's classification layer.
 *
 * The user never sees or selects these labels. The classifier assigns them
 * from the natural-language request (semantically, not keyword-matched), and
 * each intent carries strategy guidance that shapes the mission plan: what to
 * search for, what evidence matters, and which actions make sense. One
 * general agent — dynamic classification, dynamic strategy, no per-category
 * workflows.
 *
 * `intentLabel` is the AI-assigned classification; the legacy five-value
 * `missionMode` remains as a coarse entity-family derived by the classifier
 * (never user-selected) so existing queries keep working.
 */
export const intentLabels = [
  "find_opportunity",
  "find_person",
  "find_solution",
  "find_customer",
  "find_collaborator",
  "find_service",
  "find_client",
  "find_provider",
  "find_business",
] as const;

export type IntentLabel = (typeof intentLabels)[number];

export const intentLabelUnion = v.union(...intentLabels.map((label) => v.literal(label)));

export const targetEntities = [
  "person",
  "organization",
  "product_or_service",
  "mixed",
] as const;

export const targetEntityUnion = v.union(...targetEntities.map((label) => v.literal(label)));

export const missionModes = ["opportunity", "person", "customer", "solution", "collaborator"] as const;
export const missionModeUnion = v.union(...missionModes.map((label) => v.literal(label)));

/**
 * Strategy guidance per intent: what entity to hunt, which sources to
 * prioritize, what evidence to collect, what a good match looks like, and
 * which actions make sense. The classifier's structured mission references
 * these; the planner receives them as strategy context, so intent genuinely
 * changes discovery and evaluation rather than decorating prompts.
 */
export const intentStrategy: Record<IntentLabel, {
  entityFocus: string;
  sourcePriorities: string[];
  evidenceRequired: string[];
  matchCriteria: string[];
  recommendedActions: string[];
}> = {
  find_opportunity: {
    entityFocus: "organizations showing publicly expressed needs (hiring posts, project requests, RFPs, complaints about current solutions)",
    sourcePriorities: ["job boards and company career pages", "company news/blogs about growth or new projects", "community posts asking for recommendations", "freelance/contract marketplaces"],
    evidenceRequired: ["a specific stated need matching the user's offer", "recency of the need", "decision-maker or contact route", "budget or scale signals"],
    matchCriteria: ["need explicitly matches the user's offer", "evidence is recent", "a realistic contact path exists"],
    recommendedActions: ["contact_potential_client"],
  },
  find_person: {
    entityFocus: "individual professionals with verifiable skills and public profiles",
    sourcePriorities: ["personal sites and portfolios", "open-source profiles", "professional community profiles", "talks, articles, and project pages"],
    evidenceRequired: ["demonstrated skill evidence (projects, code, writing)", "seniority/signal", "availability or openness signals", "contact route"],
    matchCriteria: ["skills evidenced by concrete work", "experience matches the ask", "contactable through a public route"],
    recommendedActions: ["contact_or_invite"],
  },
  find_solution: {
    entityFocus: "products, services, or providers that solve the stated problem — the best solution type is discovered, not assumed",
    sourcePriorities: ["product/vendor sites", "comparison and review pages", "case studies", "consultant/agency profiles"],
    evidenceRequired: ["the solution addresses the specific problem", "credibility signals (customers, reviews, case studies)", "fit/pricing signals"],
    matchCriteria: ["problem-solution fit evidenced on the source", "credible track record", "realistic engagement path"],
    recommendedActions: ["evaluate_and_shortlist", "contact_provider"],
  },
  find_customer: {
    entityFocus: "organizations matching the user's ideal customer profile, with evidence of pain the user's product relieves",
    sourcePriorities: ["companies in the target segment", "product-review sites where pain is expressed", "industry news about the segment", "companies using adjacent/competitor tools"],
    evidenceRequired: ["segment/ICP fit", "evidence of the pain point", "signals of willingness to pay (stack, funding, hiring)", "use-case match"],
    matchCriteria: ["ICP attributes match", "pain evidence is concrete", "plausible use case for the user's product"],
    recommendedActions: ["outreach"],
  },
  find_collaborator: {
    entityFocus: "people or teams seeking mutual benefit on a project or venture",
    sourcePriorities: ["co-founder matching communities", "project/team pages", "open-source projects needing contributors", "builder communities"],
    evidenceRequired: ["complementary goals", "evidence of active building", "mutual-availability signals", "contact route"],
    matchCriteria: ["goals genuinely complementary", "active and recent engagement", "credible contact path"],
    recommendedActions: ["contact_or_invite"],
  },
  find_service: {
    entityFocus: "service providers or agencies delivering the requested service",
    sourcePriorities: ["agency/service-provider sites", "portfolio and case-study pages", "review platforms", "marketplace listings"],
    evidenceRequired: ["service explicitly offered", "portfolio evidence of similar work", "engagement/pricing signals", "contact route"],
    matchCriteria: ["service matches the ask", "portfolio proves capability", "contactable"],
    recommendedActions: ["evaluate_and_shortlist", "contact_provider"],
  },
  find_client: {
    entityFocus: "organizations likely to buy the user's specific service, evidenced by need signals",
    sourcePriorities: ["companies showing demand signals", "industry directories of the target niche", "community posts seeking this service", "companies hiring for the service in-house (an outsourcing signal)"],
    evidenceRequired: ["demand signal for the exact service", "company scale/fit", "contact route", "timing/recency"],
    matchCriteria: ["demand matches the user's service", "company profile fits", "recent signal"],
    recommendedActions: ["outreach"],
  },
  find_provider: {
    entityFocus: "vendors or agencies capable of supplying the needed capability at the required level",
    sourcePriorities: ["vendor comparison pages", "capability/agency directories", "case studies", "review platforms"],
    evidenceRequired: ["capability evidence at the required level", "trust signals (reviews, clients, certifications)", "engagement model fit", "contact route"],
    matchCriteria: ["capability proven", "trust signals present", "engagement feasible"],
    recommendedActions: ["evaluate_and_shortlist", "contact_provider"],
  },
  find_business: {
    entityFocus: "companies matching a structural profile (industry, size, market) rather than an expressed need",
    sourcePriorities: ["industry directories", "company lists and rankings", "news about the sector", "market maps"],
    evidenceRequired: ["industry/segment confirmation", "size/stage signals", "relevance to the user's goal", "contact route where public"],
    matchCriteria: ["profile matches the requested structure", "information is current", "relevance to the goal is explicit"],
    recommendedActions: ["evaluate_and_shortlist", "outreach"],
  },
};

/** Legacy five-value family derived from the AI intent classification. */
export function modeForIntent(label: IntentLabel): (typeof missionModes)[number] {
  switch (label) {
    case "find_person":
    case "find_provider":
    case "find_service":
      return "person";
    case "find_customer":
    case "find_client":
    case "find_business":
      return "customer";
    case "find_solution":
      return "solution";
    case "find_collaborator":
      return "collaborator";
    case "find_opportunity":
    default:
      return "opportunity";
  }
}
