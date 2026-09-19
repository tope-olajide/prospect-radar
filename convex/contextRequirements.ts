/**
 * What each mission intent needs from the user before Radar can work.
 *
 * This is the data half of Context Readiness, kept in its own module because
 * both the resolver (which reads it) and the answer path (which must write the
 * user's answer into the *right* fact category) depend on the same mapping. A
 * requirement's `key` is what the UI and run events talk about; its `category`
 * is the fact category an answer lands in. Anything that persists an answer
 * must translate key → category through `categoryForRequirement`, so a client
 * can never decouple an answer from the requirement it satisfies.
 *
 * Deliberately generic across the two-sided network: the same table serves
 * find_client (offering), find_person (seeking), find_customer (selling),
 * find_solution (problem) and so on. Nothing here assumes a job search.
 */

export type Criticality = "required" | "important" | "nice_to_have";
export type DataSourceKind = "file" | "website" | "snippet";

export type ArtifactSpec = { label: string; kinds: DataSourceKind[] };

export type Requirement = {
  key: string;
  criticality: Criticality;
  /** What Radar asks when the requirement cannot be satisfied anywhere. */
  question: string;
  /** Why the mission needs it — shown to the user, so the ask reads as reasoning. */
  why: string;
  /** Fact category this requirement reads from. */
  category: string;
  /**
   * Trust levels that satisfy this requirement. Default `["confirmed"]`, which
   * means evidence alone is not enough and Radar must ask. Requirements declare
   * `source_backed` when the user's own material is sufficient to *proceed*
   * (research, matching), while the authorized/unauthorized split in the
   * resolver keeps it out of anything that represents the user.
   */
  acceptableTrust?: Array<"confirmed" | "source_backed">;
  /** When nothing is found, the right ask is an upload/connection, not a sentence. */
  artifact?: ArtifactSpec;
};

export const REQUIREMENTS: Record<string, Requirement[]> = {
  find_opportunity: [
    {
      key: "skills", criticality: "required",
      question: "What skills or services do you offer?",
      why: "Radar matches opportunities against what you can actually deliver.",
      category: "skills", acceptableTrust: ["confirmed", "source_backed"],
    },
    {
      key: "engagement_type", criticality: "required",
      question: "What type of engagement are you looking for? (freelance, contract, full-time, project-based)",
      why: "It changes who Radar approaches — an agency retainer and a role are different searches.",
      category: "engagement",
    },
    {
      key: "location_preference", criticality: "nice_to_have",
      question: "Do you have a location or timezone preference?",
      why: "Radar skips opportunities you could not take.",
      category: "location", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_person: [
    {
      key: "role_description", criticality: "required",
      question: "What role or expertise are you looking for?",
      why: "Radar cannot search for a person without knowing what they should be able to do.",
      category: "role",
    },
    {
      key: "engagement_type", criticality: "important",
      question: "What type of engagement is this? (contract, full-time, collaboration)",
      why: "It decides whether Radar looks at freelancers, employees, or partners.",
      category: "engagement", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_customer: [
    {
      key: "product_description", criticality: "required",
      question: "What does your product or service do?",
      why: "Radar evaluates fit against the actual problem you solve.",
      category: "product", acceptableTrust: ["confirmed", "source_backed"],
      artifact: { label: "product page, one-pager, or deck", kinds: ["file", "website"] },
    },
    {
      key: "target_customer", criticality: "required",
      question: "Who is your ideal customer?",
      why: "It is the difference between a useful list and a generic one.",
      category: "target_customer",
    },
    {
      key: "geography", criticality: "important",
      question: "Do you have a target geography?",
      why: "Radar focuses its searching on the markets you can serve.",
      category: "location", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_solution: [
    {
      key: "problem_description", criticality: "required",
      question: "What problem are you trying to solve?",
      why: "Radar cannot evaluate a solution without the problem it has to fit.",
      category: "problem",
    },
    {
      key: "constraints", criticality: "important",
      question: "What constraints or requirements do you have?",
      why: "Budget, timeline, and integration limits rule options in or out.",
      category: "constraints", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_collaborator: [
    {
      key: "project_description", criticality: "required",
      question: "What is the project about?",
      why: "It frames who would be a real collaborator rather than a passer-by.",
      category: "project",
    },
    {
      key: "user_contribution", criticality: "required",
      question: "What are you bringing to the collaboration?",
      why: "Radar presents the pairing as complementary work, not a request.",
      category: "skills", acceptableTrust: ["confirmed", "source_backed"],
    },
    {
      key: "required_expertise", criticality: "required",
      question: "What expertise do you need from the collaborator?",
      why: "It is the search target.",
      category: "role",
    },
  ],
  find_service: [
    {
      key: "deliverable", criticality: "required",
      question: "What deliverable do you need?",
      why: "Radar scopes providers by what they must actually produce.",
      category: "deliverable",
    },
    {
      key: "scope", criticality: "important",
      question: "What is the scope of the work?",
      why: "Scope and timeline filter out providers who cannot fit it.",
      category: "scope", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_client: [
    {
      key: "services", criticality: "required",
      question: "What services do you offer?",
      why: "Radar matches clients against what you actually sell.",
      category: "skills", acceptableTrust: ["confirmed", "source_backed"],
    },
    {
      key: "ideal_client", criticality: "important",
      question: "What does your ideal client look like?",
      why: "It sharpens who Radar prioritises.",
      category: "target_customer", acceptableTrust: ["confirmed", "source_backed"],
    },
    {
      key: "experience", criticality: "nice_to_have",
      question: "What relevant experience do you have?",
      why: "Evidence helps Radar pick prospects where you are a credible fit.",
      category: "experience", acceptableTrust: ["confirmed", "source_backed"],
      artifact: { label: "portfolio or case studies", kinds: ["file", "website"] },
    },
  ],
  find_provider: [
    {
      key: "what_needed", criticality: "required",
      question: "What service or capability do you need?",
      why: "It is the search target.",
      category: "deliverable",
    },
    {
      key: "scope", criticality: "important",
      question: "What is the scope and timeline?",
      why: "It separates providers who can deliver in your window from those who cannot.",
      category: "scope", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
  find_business: [
    {
      key: "criteria", criticality: "required",
      question: "What criteria should Radar use to find businesses?",
      why: "Without criteria Radar would be guessing at what counts as a match.",
      category: "criteria",
    },
    {
      key: "purpose", criticality: "important",
      question: "What is the purpose of finding these businesses?",
      why: "The purpose decides which signal matters most.",
      category: "purpose", acceptableTrust: ["confirmed", "source_backed"],
    },
  ],
};

export function requirementsForIntent(intentKey: string | undefined): Requirement[] {
  if (!intentKey) return [];
  return REQUIREMENTS[intentKey] ?? [];
}

/**
 * The fact category a requirement answer belongs in. Falls back to the key so
 * an unknown requirement still persists something rather than silently
 * dropping the user's answer.
 */
export function categoryForRequirement(intentKey: string | undefined, key: string): string {
  return requirementsForIntent(intentKey).find((r) => r.key === key)?.category ?? key;
}
