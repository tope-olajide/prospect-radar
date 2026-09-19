/**
 * The action dispatcher — the step between "what did Radar find?" and "what did
 * Radar do about it?".
 *
 * It gathers what the decision layer needs (evaluated matches, resolved routes,
 * scouted forms, whether the workspace has anywhere to send from, what budget
 * remains), asks `actionDecision.decideAction` for each candidate, persists every
 * answer with its reason, and then performs **at most one** action for the best
 * candidate.
 *
 * One action per pass is deliberate. Preparing proposals for every match in a
 * single pass is how an agent turns into a mail-merge; the loop re-enters the
 * gate after each approval, so a mission that deserves to contact five people
 * still does, one reviewed message at a time.
 *
 * Nothing here sends. `send_email` prepares a draft and `submit_form` prepares a
 * proposal, both of which land behind the existing hash-bound approval gate.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  MAX_PROPOSALS_PER_PASS,
  decideAction,
  decisionRank,
  resolveSuccessPolicy,
  type CandidateInput,
  type RouteKind,
} from "./actionDecision";
import { CREDIT_COST, estimateSearch } from "./budget";

type DispatchResult = {
  decisions: number;
  proposed: number;
  investigating: number;
  blocked: number;
  resultOnly: number;
  topReason: string | null;
  topDetail: string | null;
  /** Where an investigation should go, when one was chosen. */
  investigateUrl: string | null;
};

export const decideForMission = internalAction({
  args: { missionId: v.id("missions") },
  returns: v.object({
    decisions: v.number(),
    proposed: v.number(),
    investigating: v.number(),
    blocked: v.number(),
    resultOnly: v.number(),
    topReason: v.union(v.string(), v.null()),
    topDetail: v.union(v.string(), v.null()),
    investigateUrl: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<DispatchResult> => {
    const mission = await ctx.runQuery(internal.missionsInternal.get, { missionId: args.missionId });
    if (!mission) {
      return { decisions: 0, proposed: 0, investigating: 0, blocked: 0, resultOnly: 0, topReason: "mission_unavailable", topDetail: null, investigateUrl: null };
    }

    const inbox = await ctx.runQuery(internal.outreachStore.inboxForWorkspace, {
      workspaceId: mission.workspaceId,
    });
    const budget = await ctx.runQuery(internal.budget.check, {
      workspaceId: mission.workspaceId,
      // The cheapest research call is a search; if even that is unaffordable,
      // investigation is not an option this pass.
      estimate: estimateSearch(6),
    });
    const investigationsUsed = await ctx.runQuery(internal.actionStore.investigationCount, {
      missionId: args.missionId,
    });
    const candidates = await ctx.runQuery(internal.actionStore.candidateInputs, {
      missionId: args.missionId,
    });
    // Everything the action may *represent* the user with, and the artifacts it
    // may attach, resolved once and recorded on the decision so the trace states
    // what context an action had rather than leaving it to be inferred.
    const authorizedContext = await ctx.runQuery(internal.actionStore.authorizedContextFor, {
      workspaceId: mission.workspaceId,
      missionId: args.missionId,
    });
    const artifacts = await ctx.runQuery(internal.dataSources.authorizedArtifactsFor, {
      workspaceId: mission.workspaceId,
      goal: mission.rawGoal,
    });

    const intent = mission.intent?.primary ?? mission.mode;
    // The finish line comes from the plan when it states one, so a user who
    // asked for ten clinics gets a finding mission and one who asked for a
    // reply gets an outreach mission — the intent label only decides the shape
    // of the work, not whether Radar contacts anyone.
    const plannedObjective = await ctx.runQuery(internal.plans.objectiveFor, { missionId: args.missionId });
    const objective = resolveSuccessPolicy(plannedObjective, intent);
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    const missionInput = {
      intent,
      hasInbox: Boolean(inbox),
      investigationsUsed,
      budgetAllowed: budget.allowed,
      objective,
      // Only a readable empty value counts as "no provider"; an unreadable env
      // must not make the agent give up on research it could actually do.
      researchConfigured: typeof firecrawlKey === "string" ? firecrawlKey.trim().length > 0 : true,
    };

    // Decide for every candidate, so the reasons are all on the record even
    // though only one of them will be acted on this pass.
    const decided = [];
    for (const candidate of candidates) {
      const input: CandidateInput = {
        matchId: candidate.matchId,
        subject: candidate.subject,
        label: candidate.label,
        routeKind: candidate.routeKind as RouteKind,
        routeVerified: candidate.routeVerified,
        formBlocked: candidate.formBlocked,
        alreadyActioned: candidate.alreadyActioned,
        investigateUrl: candidate.investigateUrl,
        evidenceCount: candidate.evidenceCount,
        evidence: candidate.evidence,
      };
      const decision = decideAction(input, missionInput);
      // Only an action that carries the user's material records the context and
      // artifacts it would use; a blocked or research-only decision uses none.
      const carriesUserMaterial = decision.decision === "send_email" || decision.decision === "submit_form";
      await ctx.runMutation(internal.actionStore.saveDecision, {
        workspaceId: mission.workspaceId,
        missionId: args.missionId,
        matchId: decision.matchId as never,
        quality: decision.quality,
        decision: decision.decision,
        actionability: decision.actionability,
        reason: decision.reason,
        detail: decision.detail,
        targetUrl: decision.targetUrl,
        evidence: candidate.evidence,
        capability: decision.capability,
        usedFacts: carriesUserMaterial ? authorizedContext : [],
        artifacts: carriesUserMaterial && decision.decision === "send_email" ? artifacts.map((row) => ({ sourceId: row.sourceId, title: row.title })) : [],
        alternatives: decision.alternatives,
        nextStage: decision.nextStage,
        missingEvidence: decision.missingEvidence,
      });
      decided.push({ decision, sourceId: candidate.sourceId });
    }

    const blocked = decided.filter((row) => row.decision.actionability === "blocked").length;
    const resultOnly = decided.filter((row) => row.decision.actionability === "result_only").length;
    // Best first, then only the actionable few.
    decided.sort((a, b) => decisionRank(a.decision) - decisionRank(b.decision));

    let proposed = 0;
    let investigating = 0;
    let investigateUrl: string | null = null;
    const attempted = new Set<string>();

    for (const row of decided) {
      if (proposed + investigating >= MAX_PROPOSALS_PER_PASS) break;
      const decision = row.decision;
      if (decision.decision === "no_action") continue;

      if (decision.decision === "investigate") {
        if (!decision.targetUrl) continue;
        const queued = await ctx.runMutation(internal.orchestratorStore.queueInvestigation, {
          missionId: args.missionId,
          url: decision.targetUrl,
          reason: decision.reason,
        });
        if (!queued) continue;
        investigating += 1;
        investigateUrl = decision.targetUrl;
        await ctx.runMutation(internal.runs.recordStepForAction, {
          missionId: args.missionId,
          stage: "approval",
          label: "action.investigate",
          summary: decision.detail,
          reference: decision.targetUrl,
          errorCode: null,
          tool: decision.reason === "route_unknown" ? "firecrawl.crawl" : "firecrawl.crawl",
        });
        continue;
      }

      if (decision.decision === "send_email") {
        if (!inbox) continue;
        try {
          const result = await ctx.runAction(api.ai.draftMessage, {
            workspaceId: mission.workspaceId,
            missionId: args.missionId,
            matchId: decision.matchId as never,
            agentmailInboxId: inbox.agentmailInboxId,
            clientRequestId: `mission-${args.missionId}-match-${decision.matchId}`,
            artifactIds: artifacts.map((row) => row.sourceId),
          });
          if (!result.actionId) {
            // The model produced a message but no address could be verified, or
            // it asserted something the user has not authorized. Either way
            // there is nothing approvable, and Radar says which it was.
            await ctx.runMutation(internal.runs.recordStepForAction, {
              missionId: args.missionId,
              stage: "approval",
              label: "action.proposal_withheld",
              summary: result.blockedReason === "ungrounded_claim"
                ? "Radar prepared a message but it asserted something you have not confirmed, so it withheld the draft rather than put words in your mouth."
                : "Radar prepared a message but could not verify a reachable address in the evidence, so it withheld the draft rather than guess one.",
              reference: result.blockedReason,
              errorCode: null,
              tool: "openai.draft",
            });
            attempted.add(decision.matchId);
            continue;
          }
          proposed += 1;
          await ctx.runMutation(internal.runs.recordStepForAction, {
            missionId: args.missionId,
            stage: "approval",
            label: "action.proposed",
            summary: `Proposed outreach to ${result.recipient} (${decision.quality} match): ${result.subject}${result.artifactIds.length > 0 ? `, with ${result.artifactIds.length} of your document(s) attached` : ""}. Nothing sends until you approve the exact content.`,
            reference: result.subject,
            errorCode: null,
            tool: "openai.draft",
          });
        } catch (error) {
          await ctx.runMutation(internal.runs.recordStepForAction, {
            missionId: args.missionId,
            stage: "approval",
            label: "action.proposal_failed",
            summary: `Could not prepare outreach for a ${decision.quality} match: ${error instanceof Error ? error.message : "drafting failed"}.`,
            reference: null,
            errorCode: "ACTION_PROPOSAL_FAILED",
            tool: "openai.draft",
          });
          attempted.add(decision.matchId);
        }
        continue;
      }

      if (decision.decision === "submit_form") {
        // Scouting reads the live form with Firecrawl, so it is budgeted like
        // any other research call, and it must happen before a proposal can be
        // prepared for it.
        const scrapeBudget = await ctx.runQuery(internal.budget.check, {
          workspaceId: mission.workspaceId,
          estimate: CREDIT_COST.scrape,
        });
        if (!scrapeBudget.allowed) {
          await ctx.runMutation(internal.runs.recordStepForAction, {
            missionId: args.missionId,
            stage: "approval",
            label: "action.blocked",
            summary: "A public form is the reachable route for the best match, but the mission's credit cap leaves no room to read it.",
            reference: "budget",
            errorCode: "FIRECRAWL_CREDITS_EXHAUSTED",
            tool: "context",
          });
          continue;
        }
        try {
          const template = await ctx.runAction(api.formFlows.scoutForm, {
            workspaceId: mission.workspaceId,
            missionId: args.missionId,
            sourceId: row.sourceId as never,
          });
          if (template.blockedReason) {
            await ctx.runMutation(internal.runs.recordStepForAction, {
              missionId: args.missionId,
              stage: "approval",
              label: "action.blocked",
              summary: `The reachable form for the best match is ${String(template.blockedReason).replace(/_/g, " ")}, so Radar will not fill it.`,
              reference: template.url,
              errorCode: "FORM_BLOCKED",
              tool: "firecrawl.scrape",
            });
            continue;
          }
          const proposal = await ctx.runAction(api.formFlows.proposeFill, {
            workspaceId: mission.workspaceId,
            missionId: args.missionId,
            templateId: template.templateId,
          });
          proposed += 1;
          await ctx.runMutation(internal.runs.recordStepForAction, {
            missionId: args.missionId,
            stage: "approval",
            label: "action.proposed",
            summary: `Proposed a form submission to ${template.formTitle} with ${proposal.filled} field(s) filled from your confirmed facts${proposal.unmatchedRequired.length > 0 ? `, ${proposal.unmatchedRequired.length} required field(s) still unmatched` : ""}. Nothing submits until you approve the exact values.`,
            reference: template.url,
            errorCode: null,
            tool: "firecrawl.scrape",
          });
        } catch (error) {
          await ctx.runMutation(internal.runs.recordStepForAction, {
            missionId: args.missionId,
            stage: "approval",
            label: "action.proposal_failed",
            summary: `Could not prepare the form submission: ${error instanceof Error ? error.message : "form scouting failed"}.`,
            reference: null,
            errorCode: "ACTION_PROPOSAL_FAILED",
            tool: "firecrawl.scrape",
          });
        }
      }
    }

    // The reason the gate should show: the highest-ranked candidate that did not
    // result in a prepared action, so the user reads why nothing is waiting.
    const unactioned = decided.find((row) =>
      row.decision.decision === "no_action" && !attempted.has(row.decision.matchId),
    );
    const fallback = decided.length === 0
      ? { reason: "no_candidates", detail: "Radar found no candidates for this goal." }
      : resultOnly > 0 && objective.kind !== "contact_and_wait"
        ? { reason: objective.kind, detail: "This mission is about finding the result, not contacting anyone." }
        : { reason: null, detail: null };

    return {
      decisions: decided.length,
      proposed,
      investigating,
      blocked,
      resultOnly,
      topReason: proposed > 0 || investigating > 0 ? null : (unactioned?.decision.reason ?? fallback.reason),
      topDetail: proposed > 0 || investigating > 0 ? null : (unactioned?.decision.detail ?? fallback.detail),
      investigateUrl,
    };
  },
});
