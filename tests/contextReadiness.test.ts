/**
 * Acceptance tests for the Context Readiness resolver.
 *
 * These define the contract the orchestrator relies on, so they assert the
 * *decisions* (satisfied / authorized / blocked / conflicted) rather than the
 * prose. Scenarios A–F are the product requirements:
 *
 *   A  a confirmed fact satisfies a requirement with no question
 *   B  a missing required fact blocks, is asked for, is persisted, and resumes
 *   C  an answered fact is reusable by a later mission
 *   D  evidence in the user's own material satisfies a requirement without asking
 *   E  evidence never silently becomes a confirmed fact the user is represented by
 *   F  contradictory information blocks until the user settles it
 *
 * Plus one anti-false-positive case: a source that merely adds detail is not a
 * conflict, because an agent that cries conflict over "React" + "Next.js" would
 * be worse than one that stays quiet.
 */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

/** Seeds a mission with a classified intent (real mutations, no orchestrator). */
async function seedMission(t: TestT, intent: string, rawGoal = "Find companies that need React development.") {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: rawGoal.slice(0, 80),
      rawGoal,
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists for at least one sourced match.",
    });
    await ctx.runMutation(internal.missions.applyIntent, {
      missionId,
      intent: { primary: intent, secondary: null, confidence: 0.9, rationale: "test" },
      targetEntity: "organization",
      relationshipGoal: "become_their_vendor",
      mode: "opportunity",
      clarification: null,
    });
    return missionId;
  });
}

/** Forces the run into a stage/status (test seam, bypasses transitions). */
async function forceStage(t: TestT, missionId: string, stage: string, status: string) {
  await t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    if (run) await ctx.db.patch(run._id, { currentStage: stage as never, status: status as never });
  });
}

async function readiness(t: TestT, missionId: string) {
  return t.run((ctx) => ctx.runQuery(internal.contextCheck.readinessForMission, { missionId: missionId as never }));
}

function requirement(rows: Awaited<ReturnType<typeof readiness>>, key: string) {
  const found = rows.requirements.find((r) => r.key === key);
  if (!found) throw new Error(`no requirement "${key}" in readiness result`);
  return found;
}

/** A workspace-level confirmed fact — what the user has told Radar. */
async function addConfirmedFact(t: TestT, category: string, value: string) {
  return t.run((ctx) => ctx.db.insert("contextFacts", {
    workspaceId: WORKSPACE,
    missionId: null,
    category,
    value,
    sourceType: "user_input",
    sourceReference: null,
    confidence: 1,
    verificationStatus: "user_confirmed",
    visibility: "workspace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

/** An ingested source (a file the user uploaded) with one searchable chunk. */
async function addSourceChunk(t: TestT, title: string, text: string) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const sourceId = await ctx.db.insert("dataSources", {
      workspaceId: WORKSPACE,
      kind: "file",
      title,
      url: null,
      crawlMode: "single",
      crawlId: null,
      fileId: null,
      text,
      status: "ready",
      pageCount: 0,
      lastSyncedAt: now,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("dataSourceChunks", {
      workspaceId: WORKSPACE,
      sourceId,
      ordinal: 0,
      text,
      searchText: text.toLowerCase().replace(/\s+/g, " ").trim(),
    });
    return sourceId;
  });
}

describe("context readiness — acceptance scenarios", () => {
  it("A: a confirmed fact satisfies the requirement and is authorized", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "skills", "React and Next.js development");
    await addConfirmedFact(t, "engagement", "Full-time");

    const result = await readiness(t, missionId);
    const skills = requirement(result, "skills");

    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(skills.trustLevel).toBe("confirmed");
    expect(skills.satisfied).toBe(true);
    expect(skills.authorized).toBe(true);
    expect(skills.factValue).toBe("React and Next.js development");
  });

  it("B: a missing required detail blocks, is answered, persists, and resumes", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "skills", "React");

    const before = await readiness(t, missionId);
    const engagement = requirement(before, "engagement_type");
    expect(before.ready).toBe(false);
    expect(before.blocking).toContain("engagement_type");
    expect(engagement.satisfied).toBe(false);
    expect(engagement.trustLevel).toBe("missing");
    expect(engagement.question).toMatch(/engagement/i);

    // The orchestrator parks the run at the gate before asking.
    await forceStage(t, missionId, "context_check", "waiting");
    const answered = await t.run((ctx) => ctx.runMutation(api.orchestratorStore.answerContextCheck, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      key: "engagement_type",
      answer: "Contract work",
    }));
    expect(answered.factId).toBeTruthy();
    expect(answered.resumed).toBe(true);

    // The answer became a workspace fact, not a note on the mission. It is
    // stored under the requirement's *category* ("engagement"), which is what
    // the resolver reads — the "engagement_type" key is the user-facing handle.
    const fact = await t.run((ctx) => ctx.db.get(answered.factId!));
    expect(fact?.verificationStatus).toBe("user_confirmed");
    expect(fact?.missionId).toBeNull();
    expect(fact?.category).toBe("engagement");
    expect(fact?.value).toBe("Contract work");

    // And the run left the gate on its own: nothing else scheduled it.
    const run = await t.run((ctx) => ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first());
    expect(run?.currentStage).toBe("context_check");
    expect(run?.status).toBe("active");

    const after = await readiness(t, missionId);
    expect(after.ready).toBe(true);
    expect(after.blocking).toEqual([]);
  });

  it("C: a fact answered for one mission is not asked again on the next", async () => {
    const t = convexTest(schema, convexModules);
    const first = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "skills", "React");
    await forceStage(t, first, "context_check", "waiting");
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.answerContextCheck, {
      workspaceId: WORKSPACE,
      missionId: first as never,
      key: "engagement_type",
      answer: "Contract work",
    }));

    // A second mission of the same intent inherits the workspace fact.
    const second = await seedMission(t, "find_opportunity", "Find startups that need a frontend contractor.");
    const result = await readiness(t, second);
    expect(result.ready).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(requirement(result, "engagement_type").trustLevel).toBe("confirmed");
  });

  it("D: evidence in the user's own material satisfies a requirement without asking", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "engagement", "Contract");
    await addSourceChunk(t, "Portfolio.pdf", "Built React applications for fintech companies. Skills: React, TypeScript, Next.js.");

    const result = await readiness(t, missionId);
    const skills = requirement(result, "skills");
    expect(skills.trustLevel).toBe("source_backed");
    expect(skills.satisfied).toBe(true);
    expect(skills.evidence).toContain("Portfolio.pdf");
    // Nothing is asked, so the mission can proceed on its own.
    expect(result.ready).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("E: evidence is never silently promoted into a fact the user is represented by", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "engagement", "Contract");
    await addSourceChunk(t, "Portfolio.pdf", "Built React applications for fintech companies. Skills: React, TypeScript.");

    const result = await readiness(t, missionId);
    const skills = requirement(result, "skills");
    expect(skills.satisfied).toBe(true);
    expect(skills.authorized).toBe(false);
    expect(result.unauthorized).toContain("skills");

    // No confirmed fact was created as a side effect of reading the source.
    const facts = await t.run((ctx) => ctx.db.query("contextFacts").withIndex("by_workspaceId", (q) => q.eq("workspaceId", WORKSPACE)).collect());
    expect(facts.filter((f) => f.category === "skills")).toHaveLength(0);
  });

  it("F: contradictory information blocks until the user settles it", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "skills", "React development");
    const staleFactId = await addConfirmedFact(t, "engagement", "Available for full-time work");
    await addSourceChunk(t, "Portfolio.pdf", "Currently only available for contract work through 2027.");

    const before = await readiness(t, missionId);
    const conflict = requirement(before, "engagement_type");
    expect(before.ready).toBe(false);
    expect(before.conflictCount).toBe(1);
    expect(before.blocking).toContain("engagement_type");
    expect(conflict.trustLevel).toBe("conflict");
    expect(conflict.satisfied).toBe(false);
    expect(conflict.conflictValues).toHaveLength(2);
    expect(conflict.conflictValues?.map((c) => c.origin)).toContain("your profile");
    expect(conflict.supersedes).toEqual([staleFactId]);

    await forceStage(t, missionId, "context_check", "waiting");
    const settled = await t.run((ctx) => ctx.runMutation(api.orchestratorStore.answerContextCheck, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      key: "engagement_type",
      answer: "contract",
      supersedes: conflict.supersedes!,
    }));
    expect(settled.rejected).toBe(1);

    // The losing value is rejected, not deleted — excluded from reasoning but
    // still visible to the user.
    const stale = await t.run((ctx) => ctx.db.get(staleFactId));
    expect(stale?.verificationStatus).toBe("user_rejected");

    const after = await readiness(t, missionId);
    expect(after.conflictCount).toBe(0);
    expect(after.ready).toBe(true);
    expect(requirement(after, "engagement_type").trustLevel).toBe("confirmed");
  });

  it("resolves a negated claim the user typed, rejecting the overruled fact", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    const stale = await addConfirmedFact(t, "skills", "React development");
    await addConfirmedFact(t, "engagement", "Contract");
    await addSourceChunk(t, "About me.txt", "I have no React experience at all; my background is Python and data engineering.");

    const before = await readiness(t, missionId);
    const skills = requirement(before, "skills");
    expect(skills.trustLevel).toBe("conflict");
    expect(before.ready).toBe(false);
    // A negated claim has no clean pair of labels to choose between, so it is
    // answered in the user's own words rather than by picking prose as a value.
    expect(skills.conflictValues).toBeNull();
    expect(skills.supersedes).toEqual([stale]);

    await forceStage(t, missionId, "context_check", "waiting");
    await t.run((ctx) => ctx.runMutation(api.orchestratorStore.answerContextCheck, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      key: "skills",
      answer: "Python and data engineering",
      supersedes: skills.supersedes!,
    }));

    const after = await readiness(t, missionId);
    expect(after.conflictCount).toBe(0);
    expect(after.ready).toBe(true);
    expect(requirement(after, "skills").factValue).toBe("Python and data engineering");
  });

  it("does not treat a source that merely adds detail as a conflict", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "skills", "React");
    await addConfirmedFact(t, "engagement", "Contract");
    await addSourceChunk(t, "Portfolio.pdf", "Core skills: React, Next.js, TypeScript. Freelance contractor.");

    const result = await readiness(t, missionId);
    expect(result.conflictCount).toBe(0);
    expect(result.ready).toBe(true);
    expect(requirement(result, "skills").trustLevel).toBe("confirmed");
  });

  it("requests an upload when a requirement wants an artifact instead of a sentence", async () => {
    const t = convexTest(schema, convexModules);
    // find_customer's product description accepts a product page or deck.
    const missionId = await seedMission(t, "find_customer", "Find US veterinary clinics that could use my scheduling software.");
    await addConfirmedFact(t, "target_customer", "Multi-location veterinary clinics");

    const result = await readiness(t, missionId);
    const product = requirement(result, "product_description");
    expect(product.trustLevel).toBe("missing");
    expect(product.artifactLabel).toContain("product page");
    expect(product.artifactKinds).toContain("file");
  });

  it("ignores unreviewed and rejected facts", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seedMission(t, "find_opportunity");
    await addConfirmedFact(t, "engagement", "Contract");
    await t.run((ctx) => ctx.db.insert("contextFacts", {
      workspaceId: WORKSPACE, missionId: null, category: "skills", value: "React",
      sourceType: "agent_inference", sourceReference: null, confidence: 0.6,
      verificationStatus: "unreviewed", visibility: "workspace",
      createdAt: Date.now(), updatedAt: Date.now(),
    }));

    const result = await readiness(t, missionId);
    // An inference must not satisfy a requirement.
    expect(requirement(result, "skills").trustLevel).toBe("missing");
    expect(result.ready).toBe(false);
  });
});
