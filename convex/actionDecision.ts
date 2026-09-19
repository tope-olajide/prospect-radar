/**
 * Action intelligence: given a mission, a candidate, the evidence behind it, the
 * user's authorized context and what Radar can actually execute — what should
 * Radar do next?
 *
 * This module is deliberately pure: no Convex imports, no I/O. The decision is a
 * function of its inputs, so it can be unit-tested exhaustively and read by
 * anyone wondering why the agent chose what it chose. `actions.ts` assembles the
 * inputs from the database and performs the chosen action.
 *
 * Three ideas the rest of the system depends on:
 *
 *  1. **Match quality is not actionability.** A strong match with no legitimate
 *     route is not actionable; a vague match with a reachable source and thin
 *     evidence is worth investigating. They are tracked separately and both are
 *     reported, because "why is this not actionable?" is the question a user
 *     asks most often.
 *
 *  2. **Capabilities are declared, not assumed.** Radar may only propose an
 *     action it can actually execute. There is no LinkedIn or SMS path in this
 *     product, so a counterpart reachable only that way is reported as
 *     unsupported rather than silently turned into an email.
 *
 *  3. **No action is a real outcome.** Not every match deserves contact, and not
 *     every mission ends in outreach. `no_action` carries the reason, and for
 *     research-shaped intents it is a *success*, not a failure.
 */

// ── Action types and capabilities ─────────────────────────────────────

export type ActionType = "send_email" | "submit_form" | "investigate" | "no_action";

export const actionTypes: ActionType[] = ["send_email", "submit_form", "investigate", "no_action"];

export type RouteKind = "email" | "form" | "linkedin" | null;

/**
 * What Radar can actually do. A capability that is not `implemented` can never
 * be proposed, no matter how attractive a route looks — the alternative is an
 * agent that promises the user an action the backend cannot perform.
 */
export const CAPABILITIES: Record<string, { label: string; implemented: boolean; /** What the capability needs at runtime to be usable now. */ requires: CapabilityRequirement }> = {
  send_email: { label: "Send email", implemented: true, requires: "sending_inbox" },
  submit_form: { label: "Submit a public web form", implemented: true, requires: "scrapable_target" },
  investigate: { label: "Look deeper for evidence or a route", implemented: true, requires: "research_budget" },
  schedule_meeting: { label: "Schedule a meeting", implemented: false, requires: "none" },
  linkedin_message: { label: "Message on LinkedIn", implemented: false, requires: "none" },
  sms: { label: "Send SMS", implemented: false, requires: "none" },
};

export type CapabilityKey = keyof typeof CAPABILITIES;

/**
 * What a capability needs from the workspace before it can actually run.
 * Keeping this declared — rather than discovering it inside each call site — is
 * what lets the UI and the decision layer agree on what Radar can do.
 */
export type CapabilityRequirement = "none" | "sending_inbox" | "scrapable_target" | "research_budget";

/** The runtime facts that decide whether a declared capability is usable now. */
export type CapabilityRuntime = {
  hasInbox: boolean;
  hasScrapableTarget: boolean;
  budgetAllowed: boolean;
  /** False when the deployment has no research provider configured at all. */
  researchConfigured: boolean;
};

export type CapabilityState = {
  key: string;
  label: string;
  /** False when the product does not implement it at all. */
  implemented: boolean;
  /** True only when it is implemented *and* its runtime requirement is met. */
  available: boolean;
  /** Why it is unavailable, phrased for the user; null when it is available. */
  unavailableReason: string | null;
};

/**
 * Resolves every declared capability against live workspace state.
 *
 * Both the decision layer and the UI read this, so the app cannot offer an
 * action Radar cannot execute, and Radar cannot propose one either. An
 * unimplemented capability is never "available" no matter how attractive the
 * route looks.
 */
export function resolveCapabilities(runtime: CapabilityRuntime): CapabilityState[] {
  return Object.entries(CAPABILITIES).map(([key, spec]) => {
    if (!spec.implemented) {
      return { key, label: spec.label, implemented: false, available: false, unavailableReason: "Radar cannot do this yet." };
    }
    // A missing provider is a deployment fact, not a mission fact, and it makes
    // the whole research half unavailable however promising the target looks.
    if ((spec.requires === "scrapable_target" || spec.requires === "research_budget") && !runtime.researchConfigured) {
      return { key, label: spec.label, implemented: true, available: false, unavailableReason: "This deployment has no research provider configured." };
    }
    if (spec.requires === "sending_inbox" && !runtime.hasInbox) {
      return { key, label: spec.label, implemented: true, available: false, unavailableReason: "No sending inbox is linked to this workspace." };
    }
    if (spec.requires === "scrapable_target" && !runtime.hasScrapableTarget) {
      return { key, label: spec.label, implemented: true, available: false, unavailableReason: "Radar has not found a public form or a page it can reach yet." };
    }
    if (spec.requires === "research_budget" && !runtime.budgetAllowed) {
      return { key, label: spec.label, implemented: true, available: false, unavailableReason: "The mission's credit budget leaves no room for more research." };
    }
    return { key, label: spec.label, implemented: true, available: true, unavailableReason: null };
  });
}

/** Route kinds that exist in the world but that Radar has no way to use yet. */
export const UNSUPPORTED_ROUTE_KINDS: RouteKind[] = ["linkedin"];

// ── Bounds ────────────────────────────────────────────────────────────

/**
 * How many times one mission may send itself back to research before it accepts
 * what it has. Without a bound an agent that can always "look a little deeper"
 * will never finish.
 */
export const MAX_INVESTIGATIONS = 2;

/** How many actions a single pass may prepare, so one pass cannot fan out. */
export const MAX_PROPOSALS_PER_PASS = 1;

// ── Intent policy ─────────────────────────────────────────────────────

export type SuccessKind = "contact_and_wait" | "find_candidates" | "present_solution";

export type IntentActionPolicy = {
  /** Actions worth taking for this intent, most preferred first. */
  preferred: ActionType[];
  /** Does reaching the goal require contacting the counterpart at all? */
  contactRequired: boolean;
  /** What "done" means for a mission of this intent. */
  success: { kind: SuccessKind; targetCount: number };
};

const CONTACT_POLICY: IntentActionPolicy = {
  preferred: ["send_email", "submit_form"],
  contactRequired: true,
  success: { kind: "contact_and_wait", targetCount: 1 },
};

/**
 * Intent changes what a good outcome is, not just what to search for. Without
 * this, every intent degenerates into "search, then email somebody" — which is
 * why `find_solution` and `find_business` do not contact anyone by default.
 */
export const INTENT_ACTION_POLICY: Record<string, IntentActionPolicy> = {
  find_opportunity: CONTACT_POLICY,
  find_client: CONTACT_POLICY,
  find_customer: CONTACT_POLICY,
  find_person: CONTACT_POLICY,
  find_collaborator: CONTACT_POLICY,
  find_provider: CONTACT_POLICY,
  find_service: CONTACT_POLICY,
  // The user wants a problem solved, not a vendor relationship. A strong
  // solution is the deliverable; contacting its vendor is a separate decision
  // the user makes after seeing the comparison.
  find_solution: {
    preferred: ["no_action"],
    contactRequired: false,
    success: { kind: "present_solution", targetCount: 1 },
  },
  // The user asked for a set of businesses matching a profile. Producing that
  // set is the result.
  find_business: {
    preferred: ["no_action"],
    contactRequired: false,
    success: { kind: "find_candidates", targetCount: 3 },
  },
};

export function policyForIntent(intent: string | undefined): IntentActionPolicy {
  return (intent && INTENT_ACTION_POLICY[intent]) || CONTACT_POLICY;
}

export function successPolicyFor(intent: string | undefined): IntentActionPolicy["success"] {
  return policyForIntent(intent).success;
}

/**
 * The objective a mission is actually measured against.
 *
 * The plan wins when it states one, because the plan is where the user's own
 * words ("find 10 clinics", "get a reply") were interpreted and where the user
 * can correct the interpretation. The intent's default is the fallback for
 * plans written before objectives were recorded, and for missions whose plan
 * never stated one.
 */
export function resolveSuccessPolicy(
  plan: { successKind?: string | null; targetCount?: number | null } | null | undefined,
  intent: string | undefined,
): IntentActionPolicy["success"] {
  const fallback = successPolicyFor(intent);
  if (!plan?.successKind) return fallback;
  const kind: SuccessKind = plan.successKind === "find_candidates" || plan.successKind === "present_solution"
    ? plan.successKind
    : "contact_and_wait";
  const target = typeof plan.targetCount === "number" && Number.isFinite(plan.targetCount)
    ? Math.max(1, Math.min(Math.floor(plan.targetCount), 100))
    : fallback.targetCount;
  return { kind, targetCount: target };
}

/** True when the objective can be met without contacting anyone. */
export function objectiveNeedsContact(policy: IntentActionPolicy["success"]): boolean {
  return policy.kind === "contact_and_wait";
}

// ── Decision input ───────────────────────────────────────────────────

export type MatchQuality = "stronger" | "promising" | "uncertain" | "insufficient";

export type CandidateInput = {
  matchId: string;
  subject: string;
  /** The match's evaluated fit. */
  label: string;
  /** The counterpart's verified contact route, or null when none was extracted. */
  routeKind: RouteKind;
  /** True only when the route value looks like a usable address/URL. */
  routeVerified: boolean;
  /**
   * A form was read and found unsafe or unsubmittable (login wall, captcha,
   * etc.). An *unread* form is not blocked — reading it is part of submitting.
   */
  formBlocked: boolean;
  /** Something has already been prepared for this counterpart. */
  alreadyActioned: boolean;
  /** Where to look for more evidence or a route, if investigation is needed. */
  investigateUrl: string | null;
  /** How much evidence the evaluation managed to cite. */
  evidenceCount: number;
  /** The evidence itself, so the decision record can show what it rested on. */
  evidence: string[];
};

export type MissionInput = {
  intent: string | undefined;
  /** A sending inbox is linked, so email is executable. */
  hasInbox: boolean;
  /** Investigations already spent by this mission. */
  investigationsUsed: number;
  /** Provider budget allows another research call. */
  budgetAllowed: boolean;
  /**
   * The objective the plan states, when it states one. This is what decides
   * whether reaching the goal requires contacting anyone — not the intent
   * label — so a user who asks to "find 10 clinics" gets a finding mission and
   * one who asks to "get a reply from them" gets an outreach mission.
   */
  objective: IntentActionPolicy["success"] | null;
  /**
   * False when the deployment has no research provider, so looking deeper is
   * not something Radar can actually do. Absent means "assume it can", which
   * keeps the decision layer from hiding research on an unreadable env.
   */
  researchConfigured?: boolean;
};

export type ActionDecision = {
  matchId: string;
  subject: string;
  quality: MatchQuality;
  decision: ActionType;
  actionability: "ready" | "investigate" | "blocked" | "result_only" | "not_actionable";
  /** Machine-readable reason, stable enough to branch on and assert in tests. */
  reason: string;
  /** One sentence, written for the user. */
  detail: string;
  /** Where an investigation should look, when the decision is `investigate`. */
  targetUrl: string | null;
  // ── The trace, so "why did Radar do this?" is answerable ──
  /** The capability that would carry this out; null when nothing is executed. */
  capability: string | null;
  /** The stage this sends the mission to next. */
  nextStage: "discover" | "approval" | "complete";
  /** For an investigation: what the evidence was missing. */
  missingEvidence: string | null;
  /**
   * The other actions that were considered, with the reason each was rejected.
   * Derived from the same predicates that produced the decision, never
   * reconstructed afterwards.
   */
  alternatives: Array<{ decision: ActionType; reason: string }>;
};

function qualityOf(label: string): MatchQuality {
  if (label === "stronger" || label === "promising" || label === "uncertain" || label === "insufficient") {
    return label;
  }
  return "uncertain";
}

/**
 * Decides one candidate.
 *
 * Order matters and is the whole design:
 *   1. wrong fit          → nothing to do, whatever route exists
 *   2. research-shaped    → the finding is the result; do not cold-contact
 *   3. evidence too thin  → investigate, if there is somewhere to look
 *   4. no usable route    → investigate for one, once; else blocked, never guess
 *   5. a usable route     → propose the best supported action
 */
export function decideAction(candidate: CandidateInput, mission: MissionInput): ActionDecision {
  const policy = policyForIntent(mission.intent);
  // The plan's objective wins over the intent's default: the user can ask for
  // candidates or for a reply, and the mission is measured against that.
  const objective = mission.objective ?? policy.success;
  const contactRequired = objectiveNeedsContact(objective);
  const quality = qualityOf(candidate.label);
  const investigationsLeft = MAX_INVESTIGATIONS - Math.max(0, mission.investigationsUsed);

  // Each option's blockers are computed once, up front. The decision picks the
  // best available one; the same predicates then explain, in the trace, why
  // every other option was rejected. The explanation cannot drift from the
  // decision because it is the decision's own inputs.
  const emailBlocker = !candidate.routeVerified
    ? "No address was verified in the evidence."
    : candidate.routeKind !== "email"
      ? "This counterpart has no email route."
      : !mission.hasInbox
        ? "No sending inbox is linked to this workspace."
        : null;
  const formBlocker = candidate.routeKind !== "form"
    ? "This counterpart has no public form."
    : !candidate.routeVerified
      ? "The form's address was not verified."
      : candidate.formBlocked
        ? "The form cannot be submitted safely."
        : null;
  const investigateBlocker = mission.researchConfigured === false
    ? "This deployment has no research provider configured."
    : investigationsLeft <= 0
      ? `This mission has already investigated ${MAX_INVESTIGATIONS} times.`
      : !mission.budgetAllowed
        ? "The credit budget leaves no room for more research."
        : candidate.investigateUrl === null
          ? "There is nowhere worth looking."
          : null;

  const base = {
    matchId: candidate.matchId,
    subject: candidate.subject,
    quality,
    capability: null as string | null,
    nextStage: "approval" as ActionDecision["nextStage"],
    missingEvidence: null as string | null,
    alternatives: [] as Array<{ decision: ActionType; reason: string }>,
  };
  const rejected = (chosen: ActionType) => ([
    { decision: "send_email" as ActionType, reason: emailBlocker },
    { decision: "submit_form" as ActionType, reason: formBlocker },
    { decision: "investigate" as ActionType, reason: investigateBlocker },
    { decision: "no_action" as ActionType, reason: null },
  ].filter((row): row is { decision: ActionType; reason: string } => row.reason !== null && row.decision !== chosen));

  // 1. Evidence does not support the goal.
  if (quality === "insufficient") {
    return {
      ...base,
      decision: "no_action",
      actionability: "not_actionable",
      reason: "insufficient_fit",
      detail: "The evidence does not support contacting them for this goal.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }

  // 2. This mission's objective is the finding itself.
  if (!contactRequired) {
    return {
      ...base,
      decision: "no_action",
      actionability: "result_only",
      reason: objective.kind === "present_solution" ? "objective_presents_result" : "objective_collects_candidates",
      detail: "This mission is about finding this, not contacting them — Radar recorded it as a result.",
      targetUrl: null,
      nextStage: "complete",
      alternatives: rejected("no_action"),
    };
  }

  if (candidate.alreadyActioned) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "already_actioned",
      detail: "An action for this counterpart already exists, so Radar will not prepare a second one.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }

  // 3. Judged, but on thin evidence.
  if (quality === "uncertain" && candidate.evidenceCount < 2 && investigateBlocker === null) {
    return {
      ...base,
      decision: "investigate",
      actionability: "investigate",
      reason: "evidence_insufficient",
      detail: "There is not enough evidence to justify contacting them yet, so Radar is looking deeper.",
      targetUrl: candidate.investigateUrl,
      capability: "investigate",
      nextStage: "discover",
      missingEvidence: "Enough cited evidence to justify contacting them.",
      alternatives: rejected("investigate"),
    };
  }

  const canEmail = emailBlocker === null;
  const canForm = formBlocker === null;

  // 4. Act, preferring the route this intent prefers.
  //
  // The objective decides *whether* to reach out; the intent decides the order
  // of routes when it has an opinion. A finding-shaped intent that has been
  // asked to make contact ("find me the three best, then get me a reply") has no
  // route order of its own, so the general one applies — otherwise the contact
  // the user asked for would never be attempted.
  const preferences = contactRequired
    && !policy.preferred.some((action) => action === "send_email" || action === "submit_form")
    ? (["send_email", "submit_form"] as ActionType[])
    : policy.preferred;
  for (const preference of preferences) {
    if (preference === "send_email" && canEmail) {
      return {
        ...base,
        decision: "send_email",
        actionability: "ready",
        reason: "verified_email_route",
        detail: "A fit worth acting on, with a verified address — Radar prepared a message for your approval.",
        targetUrl: null,
        capability: "send_email",
        alternatives: rejected("send_email"),
      };
    }
    if (preference === "submit_form" && canForm) {
      return {
        ...base,
        decision: "submit_form",
        actionability: "ready",
        reason: "public_form_route",
        detail: "A fit worth acting on, reachable through a public form — Radar prepared the answers for your approval.",
        targetUrl: null,
        capability: "submit_form",
        alternatives: rejected("submit_form"),
      };
    }
  }

  // 5. No usable route. Say precisely why, and only investigate when looking
  //    around could actually change the answer.
  if (candidate.routeKind === "linkedin" && candidate.routeVerified) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "unsupported_route",
      detail: "Radar found a LinkedIn profile for them but has no way to contact anyone there.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }
  if (candidate.routeKind === "form" && candidate.formBlocked) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "form_unusable",
      detail: "The only public form Radar found cannot be submitted safely, so it filled nothing.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }
  if (!mission.hasInbox && candidate.routeKind === "email") {
    // The route is known and fine; Radar simply has nowhere to send from. More
    // research cannot fix that, so this is a genuine request to the user.
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "no_inbox",
      detail: "Radar has nowhere to send from. Link an inbox and it can prepare the first message.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }
  // Looking for a contact page is what a careful person does, and it is never a
  // guess. Allowed once per mission, which is what bounds this.
  if (investigateBlocker === null) {
    return {
      ...base,
      decision: "investigate",
      actionability: "investigate",
      reason: "route_unknown",
      detail: "Radar has no verified way to reach them yet, so it is looking for one.",
      targetUrl: candidate.investigateUrl,
      capability: "investigate",
      nextStage: "discover",
      missingEvidence: "A verified way to reach this counterpart.",
      alternatives: rejected("investigate"),
    };
  }
  if (!mission.hasInbox) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "no_inbox",
      detail: "Radar has nowhere to send from, and found no other route. Link an inbox and it can prepare the first message.",
      targetUrl: null,
      alternatives: rejected("no_action"),
    };
  }
  return {
    ...base,
    decision: "no_action",
    actionability: "blocked",
    reason: "no_reachable_route",
    detail: "Radar could not verify a way to reach them and will not guess an address.",
    targetUrl: null,
    alternatives: rejected("no_action"),
  };
}

export function decisionRank(decision: ActionDecision): number {
  const quality: Record<MatchQuality, number> = { stronger: 0, promising: 1, uncertain: 2, insufficient: 3 };
  const action: Record<ActionType, number> = { send_email: 0, submit_form: 0, investigate: 1, no_action: 2 };
  return quality[decision.quality] * 10 + action[decision.decision];
}
