import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { boundedText, contentHash } from "./hash";
import { recordStep } from "./runs";

/**
 * Form flows: Radar's approval-bound submission path (docs/execution-plan.md
 * Phase 4). This module owns every database read/write; the Firecrawl calls
 * live in `formFlows.ts` so the network work never blocks a transaction.
 *
 * Hard boundaries enforced here, not by omission:
 *  - one approval is bound to one exact payload hash;
 *  - one approval executes exactly once (idempotent by proposal);
 *  - detected login walls and human checks are terminal, never attempted;
 *  - a per-workspace daily submission cap bounds blast radius.
 */

const formFieldType = v.union(
  v.literal("text"), v.literal("email"), v.literal("tel"), v.literal("url"),
  v.literal("textarea"), v.literal("select"), v.literal("checkbox"),
  v.literal("file"), v.literal("unknown"),
);
const formBlockReason = v.union(
  v.literal("login_required"), v.literal("human_check_required"), v.literal("no_form"),
);
const formProposalStatus = v.union(
  v.literal("draft"), v.literal("awaiting_approval"), v.literal("approved"),
  v.literal("executing"), v.literal("submitted"), v.literal("blocked"), v.literal("failed"),
);
const formSubmissionStatus = v.union(
  v.literal("submitted"), v.literal("blocked_login"),
  v.literal("blocked_human_check"), v.literal("failed"),
);
const formField = v.object({
  name: v.string(), label: v.string(), type: formFieldType, required: v.boolean(),
  options: v.array(v.string()), selector: v.string(), placeholder: v.string(),
});
const formFieldValue = v.object({
  name: v.string(), label: v.string(), value: v.string(),
  factId: v.union(v.id("contextFacts"), v.null()),
  factCategory: v.union(v.string(), v.null()),
});

export const APPROVAL_TTL_MS = 60 * 60 * 1000;
export const DAILY_SUBMISSION_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export const templateView = v.object({
  _id: v.id("formTemplates"),
  missionId: v.id("missions"),
  sourceId: v.id("sourceRecords"),
  url: v.string(),
  formTitle: v.string(),
  submitLabel: v.string(),
  fields: v.array(formField),
  blockedReason: v.union(formBlockReason, v.null()),
  blockedDetail: v.string(),
  confidence: v.number(),
  scoutedAt: v.number(),
  updatedAt: v.number(),
});

export const proposalView = v.object({
  _id: v.id("formProposals"),
  missionId: v.id("missions"),
  templateId: v.id("formTemplates"),
  sourceId: v.id("sourceRecords"),
  url: v.string(),
  formTitle: v.string(),
  fieldValues: v.array(formFieldValue),
  unmatchedRequired: v.array(v.string()),
  payloadHash: v.string(),
  status: formProposalStatus,
  errorSummary: v.union(v.string(), v.null()),
  approvalStatus: v.union(v.string(), v.null()),
  approvalExpiresAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const submissionView = v.object({
  _id: v.id("formSubmissions"),
  missionId: v.id("missions"),
  proposalId: v.id("formProposals"),
  url: v.string(),
  formTitle: v.string(),
  fieldCount: v.number(),
  status: formSubmissionStatus,
  errorCode: v.union(v.string(), v.null()),
  errorSummary: v.union(v.string(), v.null()),
  evidenceUrl: v.union(v.string(), v.null()),
  postSubmitExcerpt: v.string(),
  submittedAt: v.union(v.number(), v.null()),
  createdAt: v.number(),
});

/**
 * Canonical hash of a form payload: the exact target URL plus the ordered
 * field values, under the `submit_form` capability. Any drift between what the
 * user approved and what would be submitted fails closed.
 */
export async function formPayloadHash(
  url: string,
  fields: Array<{ name: string; value: string }>,
) {
  const canonical = JSON.stringify(
    fields
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((field) => [field.name, field.value] as const),
  );
  return await contentHash(url.trim(), "submit_form", canonical, "submit_form");
}

function normalizeField(raw: {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  selector: string;
  placeholder: string;
}) {
  return {
    name: boundedText(raw.name, 120),
    label: boundedText(raw.label, 160),
    type: raw.type as
      | "text" | "email" | "tel" | "url" | "textarea" | "select" | "checkbox" | "file" | "unknown",
    required: raw.required,
    options: raw.options.slice(0, 30).map((option) => boundedText(option, 120)),
    selector: boundedText(raw.selector, 200),
    placeholder: boundedText(raw.placeholder, 160),
  };
}

/** Persist a scouted form. Replaces any prior scout of the same mission+URL. */
export const saveTemplate = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    sourceId: v.id("sourceRecords"),
    url: v.string(),
    formTitle: v.string(),
    submitLabel: v.string(),
    fields: v.array(formField),
    blockedReason: v.union(formBlockReason, v.null()),
    blockedDetail: v.string(),
    confidence: v.number(),
  },
  returns: v.object({ templateId: v.id("formTemplates"), replaced: v.boolean() }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const now = Date.now();
    const fields = args.fields.map(normalizeField);
    const existing = await ctx.db.query("formTemplates")
      .withIndex("by_missionId_and_url", (q) => q.eq("missionId", args.missionId).eq("url", args.url))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sourceId: args.sourceId,
        formTitle: boundedText(args.formTitle, 200) || existing.formTitle,
        submitLabel: boundedText(args.submitLabel, 120),
        fields,
        blockedReason: args.blockedReason,
        blockedDetail: boundedText(args.blockedDetail, 500),
        confidence: Math.max(0, Math.min(1, args.confidence)),
        scoutedAt: now,
        updatedAt: now,
      });
      return { templateId: existing._id, replaced: true };
    }
    const templateId = await ctx.db.insert("formTemplates", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      sourceId: args.sourceId,
      url: args.url,
      formTitle: boundedText(args.formTitle, 200) || "Untitled form",
      submitLabel: boundedText(args.submitLabel, 120),
      fields,
      blockedReason: args.blockedReason,
      blockedDetail: boundedText(args.blockedDetail, 500),
      confidence: Math.max(0, Math.min(1, args.confidence)),
      scoutedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { templateId, replaced: false };
  },
});

export const templateById = internalQuery({
  args: { workspaceId: v.string(), templateId: v.id("formTemplates") },
  returns: v.union(templateView, v.null()),
  handler: async (ctx, args) => {
    const template = await ctx.db.get(args.templateId);
    if (!template || template.workspaceId !== args.workspaceId) return null;
    const { _creationTime, workspaceId, createdAt, ...view } = template;
    return view;
  },
});

/** Confirmed context facts eligible to fill a form (never unreviewed ones). */
export const confirmedFacts = internalQuery({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(v.object({
    _id: v.id("contextFacts"),
    missionId: v.union(v.id("missions"), v.null()),
    category: v.string(),
    value: v.string(),
  })),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    return rows
      .filter((row) =>
        ["user_confirmed", "user_corrected"].includes(row.verificationStatus) &&
        (row.missionId === null || row.missionId === args.missionId))
      .slice(0, 40)
      .map((row) => ({
        _id: row._id,
        missionId: row.missionId,
        category: row.category,
        value: boundedText(row.value, 600),
      }));
  },
});

/**
 * Persist a proposal. Every non-empty value must cite a confirmed fact the
 * caller supplied; the mapping is re-validated here so a compromised LLM
 * response cannot smuggle an unconfirmed value into an approvable payload.
 */
export const saveProposal = internalMutation({
  args: {
    workspaceId: v.string(),
    missionId: v.id("missions"),
    templateId: v.id("formTemplates"),
    sourceId: v.id("sourceRecords"),
    url: v.string(),
    formTitle: v.string(),
    fieldValues: v.array(formFieldValue),
    unmatchedRequired: v.array(v.string()),
  },
  returns: v.object({ proposalId: v.id("formProposals"), payloadHash: v.string() }),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: mission is not in this workspace.");
    }
    const factRows = await ctx.db.query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    const eligible = new Map(
      factRows
        .filter((row) =>
          ["user_confirmed", "user_corrected"].includes(row.verificationStatus) &&
          (row.missionId === null || row.missionId === args.missionId))
        .map((row) => [row._id, row] as const),
    );

    const fieldValues = args.fieldValues.map((field) => {
      const value = boundedText(field.value, 600);
      const fact = field.factId ? eligible.get(field.factId) : undefined;
      // A value with no confirmed fact behind it is not eligible for a
      // submission; it is dropped rather than trusted.
      const grounded = value && fact ? { value, fact } : null;
      return {
        name: boundedText(field.name, 120),
        label: boundedText(field.label, 160),
        value: grounded ? grounded.value : "",
        factId: grounded ? grounded.fact._id : null,
        factCategory: grounded ? grounded.fact.category : null,
      };
    });

    const payloadHash = await formPayloadHash(
      args.url,
      fieldValues.filter((field) => field.value).map((field) => ({ name: field.name, value: field.value })),
    );
    const now = Date.now();
    const proposalId = await ctx.db.insert("formProposals", {
      workspaceId: args.workspaceId,
      missionId: args.missionId,
      templateId: args.templateId,
      sourceId: args.sourceId,
      url: args.url,
      formTitle: boundedText(args.formTitle, 200) || "Untitled form",
      fieldValues,
      unmatchedRequired: args.unmatchedRequired.slice(0, 40).map((name) => boundedText(name, 120)),
      payloadHash,
      status: "draft",
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    });
    return { proposalId, payloadHash };
  },
});

export const proposalById = internalQuery({
  args: { workspaceId: v.string(), proposalId: v.id("formProposals") },
  returns: v.union(proposalView, v.null()),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) return null;
    const approval = await ctx.db.query("approvals")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .first();
    return {
      _id: proposal._id,
      missionId: proposal.missionId,
      templateId: proposal.templateId,
      sourceId: proposal.sourceId,
      url: proposal.url,
      formTitle: proposal.formTitle,
      fieldValues: proposal.fieldValues,
      unmatchedRequired: proposal.unmatchedRequired,
      payloadHash: proposal.payloadHash,
      status: proposal.status,
      errorSummary: proposal.errorSummary,
      approvalStatus: approval ? approval.status : null,
      approvalExpiresAt: approval ? approval.expiresAt : null,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
    };
  },
});

/**
 * Approve the exact proposed payload. Refuses while a required field is still
 * unmatched — a half-filled form is never approvable — and binds the approval
 * to the payload hash rather than to the proposal row.
 */
export const approveProposal = mutation({
  args: { workspaceId: v.string(), proposalId: v.id("formProposals") },
  returns: v.object({ proposalId: v.id("formProposals"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: proposal is not in this workspace.");
    }
    if (proposal.status === "submitted" || proposal.status === "executing") {
      throw new Error("APPROVAL_REQUIRED: this proposal was already submitted.");
    }
    const template = await ctx.db.get(proposal.templateId);
    if (!template) throw new Error("Template not found for this proposal.");
    if (template.blockedReason) {
      throw new Error(`FORM_BLOCKED: the target form is ${template.blockedReason.replace(/_/g, " ")}; Radar will not attempt it.`);
    }
    if (proposal.unmatchedRequired.length > 0) {
      throw new Error(`FORM_INCOMPLETE: fill or remove required fields first: ${proposal.unmatchedRequired.join(", ")}.`);
    }
    const storedHash = await formPayloadHash(
      proposal.url,
      proposal.fieldValues.filter((field) => field.value).map((field) => ({ name: field.name, value: field.value })),
    );
    if (storedHash !== proposal.payloadHash) {
      throw new Error("APPROVAL_STALE: stored payload hash mismatch; re-propose the fill.");
    }
    const now = Date.now();
    const expiresAt = now + APPROVAL_TTL_MS;
    const existing = await ctx.db.query("approvals")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .first();
    if (existing && existing.status === "active" && existing.contentHash === storedHash && existing.expiresAt > now) {
      await ctx.db.patch(proposal._id, { status: "approved", updatedAt: now });
      return { proposalId: proposal._id, expiresAt: existing.expiresAt };
    }
    const value = {
      proposalId: proposal._id,
      capability: "submit_form" as const,
      recipient: proposal.url,
      contentHash: storedHash,
      approvedBy: args.workspaceId,
      status: "active" as const,
      expiresAt,
      resolvedAt: null,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("approvals", { ...value, createdAt: now });
    }
    await ctx.db.patch(proposal._id, { status: "approved", errorSummary: null, updatedAt: now });
    await recordStep(ctx, {
      missionId: proposal.missionId,
      stage: "approval",
      label: "form.approved",
      summary: `User approved ${proposal.fieldValues.filter((field) => field.value).length} field value(s) for ${proposal.url}. One approval, one submission.`,
      reference: proposal._id,
      tool: "approval",
    });
    return { proposalId: proposal._id, expiresAt };
  },
});

/** Update proposal field values before approval (user corrections). */
export const reviseProposalValues = mutation({
  args: {
    workspaceId: v.string(),
    proposalId: v.id("formProposals"),
    fieldValues: v.array(v.object({
      name: v.string(),
      value: v.string(),
      factId: v.union(v.id("contextFacts"), v.null()),
    })),
  },
  returns: v.object({ proposalId: v.id("formProposals"), payloadHash: v.string(), unmatchedRequired: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: proposal is not in this workspace.");
    }
    if (["submitted", "executing"].includes(proposal.status)) {
      throw new Error("APPROVAL_REQUIRED: a submitted proposal can no longer be edited.");
    }
    const factRows = await ctx.db.query("contextFacts")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    const eligible = new Map(
      factRows
        .filter((row) =>
          ["user_confirmed", "user_corrected"].includes(row.verificationStatus) &&
          (row.missionId === null || row.missionId === proposal.missionId))
        .map((row) => [row._id, row] as const),
    );
    const byName = new Map(args.fieldValues.map((field) => [boundedText(field.name, 120), field] as const));
    const fieldValues = proposal.fieldValues.map((field) => {
      const edit = byName.get(field.name);
      if (!edit) return field;
      const value = boundedText(edit.value, 600);
      const fact = edit.factId ? eligible.get(edit.factId) : undefined;
      const grounded = value && fact ? { value, fact } : null;
      return {
        ...field,
        value: grounded ? grounded.value : "",
        factId: grounded ? grounded.fact._id : null,
        factCategory: grounded ? grounded.fact.category : null,
      };
    });
    const template = await ctx.db.get(proposal.templateId);
    const unmatchedRequired = (template?.fields ?? [])
      .filter((field) => field.required && !fieldValues.some((value) => value.name === field.name && value.value))
      .map((field) => field.label || field.name);
    const payloadHash = await formPayloadHash(
      proposal.url,
      fieldValues.filter((field) => field.value).map((field) => ({ name: field.name, value: field.value })),
    );
    await ctx.db.patch(proposal._id, {
      fieldValues,
      unmatchedRequired,
      payloadHash,
      status: "draft",
      errorSummary: null,
      updatedAt: Date.now(),
    });
    // A revised payload invalidates any prior approval.
    const approval = await ctx.db.query("approvals")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .first();
    if (approval && approval.status === "active" && approval.contentHash !== payloadHash) {
      await ctx.db.patch(approval._id, { status: "revoked", resolvedAt: Date.now() });
    }
    return { proposalId: proposal._id, payloadHash, unmatchedRequired };
  },
});

export const submissionForProposal = internalQuery({
  args: { proposalId: v.id("formProposals") },
  returns: v.union(submissionView, v.null()),
  handler: async (ctx, args) => await submissionViewFor(ctx, args.proposalId),
});

async function submissionViewFor(ctx: QueryCtx, proposalId: Id<"formProposals">) {
  const submission = await ctx.db.query("formSubmissions")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
    .first();
  if (!submission) return null;
  return {
    _id: submission._id,
    missionId: submission.missionId,
    proposalId: submission.proposalId,
    url: submission.url,
    formTitle: submission.formTitle,
    fieldCount: submission.fieldCount,
    status: submission.status,
    errorCode: submission.errorCode,
    errorSummary: submission.errorSummary,
    evidenceUrl: submission.evidenceFileId ? await ctx.storage.getUrl(submission.evidenceFileId) : null,
    postSubmitExcerpt: submission.postSubmitExcerpt,
    submittedAt: submission.submittedAt,
    createdAt: submission.createdAt,
  };
}

/**
 * The single transactional gate in front of every submission. Checks
 * idempotency, the approval binding, the block boundary, and the daily cap
 * atomically, then marks the approval used and the proposal executing.
 */
export const claimExecution = internalMutation({
  args: { workspaceId: v.string(), proposalId: v.id("formProposals") },
  returns: v.object({
    alreadySubmitted: v.boolean(),
    submission: v.union(submissionView, v.null()),
    template: v.union(templateView, v.null()),
    fieldValues: v.array(formFieldValue),
    url: v.string(),
    formTitle: v.string(),
  }),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: proposal is not in this workspace.");
    }
    // Exactly-once: a second call after a submission exists never re-runs.
    const existingSubmission = await submissionViewFor(ctx, proposal._id);
    if (existingSubmission) {
      return {
        alreadySubmitted: true,
        submission: existingSubmission,
        template: null,
        fieldValues: [],
        url: proposal.url,
        formTitle: proposal.formTitle,
      };
    }
    const template = await ctx.db.get(proposal.templateId);
    if (!template) throw new Error("Template not found for this proposal.");
    if (template.blockedReason) {
      throw new Error(`FORM_BLOCKED: the target form is ${template.blockedReason.replace(/_/g, " ")}.`);
    }
    if (proposal.unmatchedRequired.length > 0) {
      throw new Error(`FORM_INCOMPLETE: required fields are still unmatched: ${proposal.unmatchedRequired.join(", ")}.`);
    }
    const approval = await ctx.db.query("approvals")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .first();
    if (!approval || approval.status !== "active") {
      throw new Error("APPROVAL_REQUIRED: approve this exact payload before submitting.");
    }
    if (approval.expiresAt <= Date.now()) {
      throw new Error("APPROVAL_STALE: approval expired; approve again.");
    }
    const now = Date.now();
    const recheckHash = await formPayloadHash(
      proposal.url,
      proposal.fieldValues.filter((field) => field.value).map((field) => ({ name: field.name, value: field.value })),
    );
    if (approval.contentHash !== recheckHash || proposal.payloadHash !== recheckHash) {
      throw new Error("APPROVAL_STALE: the payload changed after approval; approve again.");
    }
    const recent = await ctx.db.query("formSubmissions")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    const inWindow = recent.filter((row) => row.createdAt >= now - DAY_MS).length;
    if (inWindow >= DAILY_SUBMISSION_CAP) {
      throw new Error(`FORM_CAP_REACHED: the daily submission cap of ${DAILY_SUBMISSION_CAP} was reached for this workspace.`);
    }
    await ctx.db.patch(approval._id, { status: "used", resolvedAt: now });
    await ctx.db.patch(proposal._id, { status: "executing", errorSummary: null, updatedAt: now });
    await recordStep(ctx, {
      missionId: proposal.missionId,
      stage: "execute",
      label: "form.executing",
      summary: `Submitting the approved payload to ${proposal.url}. Screenshot evidence will be captured.`,
      reference: proposal._id,
      tool: "firecrawl.form",
    });
    const { _creationTime, createdAt, workspaceId, ...templateViewValue } = template;
    return {
      alreadySubmitted: false,
      submission: null,
      template: templateViewValue,
      fieldValues: proposal.fieldValues,
      url: proposal.url,
      formTitle: proposal.formTitle,
    };
  },
});

/** Record the outcome of one submission attempt (the immutable record). */
export const recordSubmission = internalMutation({
  args: {
    workspaceId: v.string(),
    proposalId: v.id("formProposals"),
    status: formSubmissionStatus,
    errorCode: v.union(v.string(), v.null()),
    errorSummary: v.union(v.string(), v.null()),
    evidenceFileId: v.union(v.id("_storage"), v.null()),
    postSubmitExcerpt: v.string(),
    fieldCount: v.number(),
  },
  returns: v.id("formSubmissions"),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) {
      throw new Error("FORBIDDEN_SCOPE: proposal is not in this workspace.");
    }
    const existing = await ctx.db.query("formSubmissions")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", args.proposalId))
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    const submitted = args.status === "submitted";
    const submissionId = await ctx.db.insert("formSubmissions", {
      workspaceId: args.workspaceId,
      missionId: proposal.missionId,
      proposalId: proposal._id,
      templateId: proposal.templateId,
      url: proposal.url,
      formTitle: proposal.formTitle,
      fieldCount: args.fieldCount,
      status: args.status,
      errorCode: args.errorCode,
      errorSummary: args.errorSummary ? boundedText(args.errorSummary, 400) : null,
      evidenceFileId: args.evidenceFileId,
      postSubmitExcerpt: boundedText(args.postSubmitExcerpt, 800),
      submittedAt: submitted ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    const proposalStatus = submitted
      ? "submitted" as const
      : args.status === "failed" ? "failed" as const : "blocked" as const;
    await ctx.db.patch(args.proposalId, {
      status: proposalStatus,
      errorSummary: args.errorSummary ? boundedText(args.errorSummary, 400) : null,
      updatedAt: now,
    });
    await recordStep(ctx, {
      missionId: proposal.missionId,
      stage: "execute",
      label: submitted ? "form.executed" : "form.blocked",
      summary: submitted
        ? `Submission captured for ${proposal.url}. Evidence and post-submit text stored.`
        : `Radar stopped at ${proposal.url}: ${boundedText(args.errorSummary ?? args.status, 300)}`,
      reference: submissionId,
      errorCode: args.errorCode,
      tool: "firecrawl.form",
    });
    return submissionId;
  },
});

export const listTemplates = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(templateView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("formTemplates")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(30);
    return rows.map(({ _creationTime, workspaceId, createdAt, ...view }) => view);
  },
});

export const listProposals = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(proposalView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("formProposals")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(30);
    const result = [];
    for (const row of rows) {
      const approval = await ctx.db.query("approvals")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", row._id))
        .first();
      result.push({
        _id: row._id,
        missionId: row.missionId,
        templateId: row.templateId,
        sourceId: row.sourceId,
        url: row.url,
        formTitle: row.formTitle,
        fieldValues: row.fieldValues,
        unmatchedRequired: row.unmatchedRequired,
        payloadHash: row.payloadHash,
        status: row.status,
        errorSummary: row.errorSummary,
        approvalStatus: approval ? approval.status : null,
        approvalExpiresAt: approval ? approval.expiresAt : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return result;
  },
});

export const listSubmissions = query({
  args: { workspaceId: v.string(), missionId: v.id("missions") },
  returns: v.array(submissionView),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.workspaceId !== args.workspaceId) return [];
    const rows = await ctx.db.query("formSubmissions")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(50);
    const result = [];
    for (const row of rows) {
      result.push({
        _id: row._id,
        missionId: row.missionId,
        proposalId: row.proposalId,
        url: row.url,
        formTitle: row.formTitle,
        fieldCount: row.fieldCount,
        status: row.status,
        errorCode: row.errorCode,
        errorSummary: row.errorSummary,
        evidenceUrl: row.evidenceFileId ? await ctx.storage.getUrl(row.evidenceFileId) : null,
        postSubmitExcerpt: row.postSubmitExcerpt,
        submittedAt: row.submittedAt,
        createdAt: row.createdAt,
      });
    }
    return result;
  },
});

/** Daily cap usage for the UI (counts submitted attempts in the last day). */
export const capStatus = query({
  args: { workspaceId: v.string() },
  returns: v.object({ used: v.number(), cap: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("formSubmissions")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .take(200);
    const used = rows.filter((row) => row.createdAt >= Date.now() - DAY_MS).length;
    return { used, cap: DAILY_SUBMISSION_CAP };
  },
});

/** Test/ops helper: mark a stuck execution failed without inventing a record. */
export const abandonExecution = internalMutation({
  args: { workspaceId: v.string(), proposalId: v.id("formProposals"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal || proposal.workspaceId !== args.workspaceId) return null;
    if (proposal.status === "executing") {
      await ctx.db.patch(proposal._id, { status: "draft", errorSummary: boundedText(args.reason, 300), updatedAt: Date.now() });
    }
    return null;
  },
});

/** Internal helper for tests: read a proposal without the public validator. */
export const rawProposal = internalQuery({
  args: { proposalId: v.id("formProposals") },
  returns: v.union(
    v.object({
      _id: v.id("formProposals"),
      missionId: v.id("missions"),
      workspaceId: v.string(),
      status: formProposalStatus,
      payloadHash: v.string(),
      unmatchedRequired: v.array(v.string()),
      fieldValues: v.array(formFieldValue),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.proposalId);
    if (!row) return null;
    return {
      _id: row._id,
      missionId: row.missionId,
      workspaceId: row.workspaceId,
      status: row.status,
      payloadHash: row.payloadHash,
      unmatchedRequired: row.unmatchedRequired,
      fieldValues: row.fieldValues,
    };
  },
});
