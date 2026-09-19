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
export const CAPABILITIES: Record<string, { label: string; implemented: boolean }> = {
  send_email: { label: "Send email", implemented: true },
  submit_form: { label: "Submit a public web form", implemented: true },
  investigate: { label: "Look deeper for evidence or a route", implemented: true },
  schedule_meeting: { label: "Schedule a meeting", implemented: false },
  linkedin_message: { label: "Message on LinkedIn", implemented: false },
  sms: { label: "Send SMS", implemented: false },
};

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
};

export type MissionInput = {
  intent: string | undefined;
  /** A sending inbox is linked, so email is executable. */
  hasInbox: boolean;
  /** Investigations already spent by this mission. */
  investigationsUsed: number;
  /** Provider budget allows another research call. */
  budgetAllowed: boolean;
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
  const quality = qualityOf(candidate.label);
  const base = { matchId: candidate.matchId, subject: candidate.subject, quality };

  // 1. Evidence does not support the goal.
  if (quality === "insufficient") {
    return {
      ...base,
      decision: "no_action",
      actionability: "not_actionable",
      reason: "insufficient_fit",
      detail: "The evidence does not support contacting them for this goal.",
      targetUrl: null,
    };
  }

  // 2. This intent is satisfied by the finding itself.
  if (!policy.contactRequired) {
    return {
      ...base,
      decision: "no_action",
      actionability: "result_only",
      reason: policy.success.kind === "present_solution" ? "intent_presents_result" : "intent_collects_candidates",
      detail: "This mission is about finding this, not contacting them — Radar recorded it as a result.",
      targetUrl: null,
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
    };
  }

  const investigationsLeft = MAX_INVESTIGATIONS - Math.max(0, mission.investigationsUsed);
  const canInvestigate = investigationsLeft > 0 && mission.budgetAllowed && candidate.investigateUrl !== null;

  // 3. Judged, but on thin evidence.
  if (quality === "uncertain" && candidate.evidenceCount < 2 && canInvestigate) {
    return {
      ...base,
      decision: "investigate",
      actionability: "investigate",
      reason: "evidence_insufficient",
      detail: "There is not enough evidence to justify contacting them yet, so Radar is looking deeper.",
      targetUrl: candidate.investigateUrl,
    };
  }

  // 4. Which routes can Radar actually use, right now?
  const canEmail = candidate.routeKind === "email" && candidate.routeVerified
    && mission.hasInbox && CAPABILITIES.send_email.implemented;
  const canForm = candidate.routeKind === "form" && candidate.routeVerified
    && !candidate.formBlocked && CAPABILITIES.submit_form.implemented;

  // 5. Act, preferring the route this intent prefers.
  for (const preference of policy.preferred) {
    if (preference === "send_email" && canEmail) {
      return {
        ...base,
        decision: "send_email",
        actionability: "ready",
        reason: "verified_email_route",
        detail: "A fit worth acting on, with a verified address — Radar prepared a message for your approval.",
        targetUrl: null,
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
      };
    }
  }

  // 6. No usable route. Say precisely why, and only investigate when looking
  //    around could actually change the answer.
  if (candidate.routeKind === "email" && candidate.routeVerified && !mission.hasInbox) {
    // The route is known and fine; Radar simply has nowhere to send from. More
    // research cannot fix that, so this is a genuine request to the user.
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "no_inbox",
      detail: "Radar has nowhere to send from. Link an inbox and it can prepare the first message.",
      targetUrl: null,
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
    };
  }
  if (candidate.routeKind !== null && UNSUPPORTED_ROUTE_KINDS.includes(candidate.routeKind)) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "unsupported_route",
      detail: `Radar found a ${candidate.routeKind} profile for them but has no way to contact anyone there.`,
      targetUrl: null,
    };
  }
  // Looking for a contact page is what a careful person does, and it is never a
  // guess. Allowed once per mission, which is what bounds this.
  if (canInvestigate) {
    return {
      ...base,
      decision: "investigate",
      actionability: "investigate",
      reason: "route_unknown",
      detail: "Radar has no verified way to reach them yet, so it is looking for one.",
      targetUrl: candidate.investigateUrl,
    };
  }
  if (!mission.hasInbox && candidate.routeKind === null) {
    return {
      ...base,
      decision: "no_action",
      actionability: "blocked",
      reason: "no_inbox",
      detail: "Radar has nowhere to send from, and found no other route. Link an inbox and it can prepare the first message.",
      targetUrl: null,
    };
  }
  return {
    ...base,
    decision: "no_action",
    actionability: "blocked",
    reason: "no_reachable_route",
    detail: "Radar could not verify a way to reach them and will not guess an address.",
    targetUrl: null,
  };
}

/** Ranks decisions so the caller can act on the best candidate first. */
export function decisionRank(decision: ActionDecision): number {
  const quality: Record<MatchQuality, number> = { stronger: 0, promising: 1, uncertain: 2, insufficient: 3 };
  const action: Record<ActionType, number> = { send_email: 0, submit_form: 0, investigate: 1, no_action: 2 };
  return quality[decision.quality] * 10 + action[decision.decision];
}
