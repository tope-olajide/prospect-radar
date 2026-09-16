import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const convexModules = import.meta.glob("../convex/**/*.ts");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";
const OTHER_WORKSPACE = "attacker-workspace";

/**
 * The editable brief is the user's override over the model's plan. It ships the
 * completion predicate that gates the run's own completion claim, so it must be
 * persisted exactly, recorded on the run trail, and unusable across workspaces.
 */
async function seed(t: TestT) {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Find companies that need React development.",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists.",
    });
    await ctx.runMutation(internal.plans.save, {
      missionId,
      normalizedGoal: "Find companies that need React development.",
      mode: "opportunity",
      mustHave: ["needs React work"],
      niceToHave: ["hiring signal"],
      exclusions: ["staffing agencies"],
      missingFacts: ["budget"],
      recommendedSources: ["company career pages"],
      proposedSteps: ["search", "evaluate"],
      completionPredicate: "A user-approved next action exists.",
      provider: "openai",
      model: "test-model",
    });
    return missionId;
  });
}

describe("editable mission brief (command center)", () => {
  it("persists the edited brief and mirrors the predicate onto the mission", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seed(t);

    const result = await t.mutation(api.plans.updateBrief, {
      workspaceId: WORKSPACE,
      missionId,
      normalizedGoal: "Find product-design clients in Lagos.",
      mustHave: ["climate focus", "growing design team"],
      niceToHave: ["Series A"],
      exclusions: ["staffing agencies", "recruiters"],
      recommendedSources: ["company blogs"],
      completionPredicate: "Three sourced matches are approved and sent.",
    });

    expect(result.completionPredicate).toBe("Three sourced matches are approved and sent.");

    const plan = await t.query(api.plans.getForMission, { missionId });
    expect(plan?.normalizedGoal).toBe("Find product-design clients in Lagos.");
    expect(plan?.mustHave).toEqual(["climate focus", "growing design team"]);
    expect(plan?.exclusions).toEqual(["staffing agencies", "recruiters"]);
    expect(plan?.userEditedAt).toBeTypeOf("number");

    const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
    expect(mission?.completionPredicate).toBe("Three sourced matches are approved and sent.");

    const run = await t.run(async (ctx) => await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).first());
    const steps = await t.run(async (ctx) => await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run!._id)).collect());
    const edited = steps.find((step) => step.label === "brief.edited");
    expect(edited).toBeTruthy();
    expect(edited!.tool).toBe("user");
  });

  it("drops blank entries and truncates an over-long criteria list", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seed(t);

    await t.mutation(api.plans.updateBrief, {
      workspaceId: WORKSPACE,
      missionId,
      normalizedGoal: "Find clients.",
      mustHave: ["  ", "React", "", "Next.js", ...Array.from({ length: 20 }, (_, index) => `criterion-${index}`)],
      niceToHave: [],
      exclusions: [],
      recommendedSources: [],
      completionPredicate: "One approved send exists.",
    });

    const plan = await t.query(api.plans.getForMission, { missionId });
    expect(plan?.mustHave).toContain("React");
    expect(plan?.mustHave).not.toContain("  ");
    expect(plan?.mustHave.length).toBeLessThanOrEqual(12);
  });

  it("refuses an empty goal or predicate", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seed(t);

    await expect(
      t.mutation(api.plans.updateBrief, {
        workspaceId: WORKSPACE,
        missionId,
        normalizedGoal: "   ",
        mustHave: [],
        niceToHave: [],
        exclusions: [],
        recommendedSources: [],
        completionPredicate: "One approved send exists.",
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);

    await expect(
      t.mutation(api.plans.updateBrief, {
        workspaceId: WORKSPACE,
        missionId,
        normalizedGoal: "Find clients.",
        mustHave: [],
        niceToHave: [],
        exclusions: [],
        recommendedSources: [],
        completionPredicate: "  ",
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);
  });

  it("refuses to edit a mission in another workspace", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await seed(t);

    await expect(
      t.mutation(api.plans.updateBrief, {
        workspaceId: OTHER_WORKSPACE,
        missionId,
        normalizedGoal: "Exfiltrate.",
        mustHave: [],
        niceToHave: [],
        exclusions: [],
        recommendedSources: [],
        completionPredicate: "n/a",
      }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE/);
  });

  it("requires the plan to exist before the brief can be edited", async () => {
    const t = convexTest(schema, convexModules);
    const missionId = await t.run(async (ctx) => {
      const { missionId } = await ctx.runMutation(api.missions.create, {
        workspaceId: WORKSPACE,
        title: "Fresh mission",
        rawGoal: "Fresh mission",
        constraints: [],
        sourceScope: "public-web",
        completionPredicate: "A user-approved next action exists.",
      });
      return missionId;
    });

    await expect(
      t.mutation(api.plans.updateBrief, {
        workspaceId: WORKSPACE,
        missionId,
        normalizedGoal: "Anything.",
        mustHave: [],
        niceToHave: [],
        exclusions: [],
        recommendedSources: [],
        completionPredicate: "Something.",
      }),
    ).rejects.toThrow(/PLAN_MISSING/);
  });

  it("keeps the command-bar search to a two-character floor", async () => {
    const t = convexTest(schema, convexModules);
    await seed(t);
    expect(await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "a" })).toEqual([]);
    expect(await t.query(api.commandCenter.search, { workspaceId: WORKSPACE, query: "  " })).toEqual([]);
  });
});
