import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const convexModules = import.meta.glob("../convex/**/*.ts");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

async function seedMission(t: TestT) {
  return t.run(async (ctx) => {
    const { missionId, runId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Run query contract",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists.",
    });
    return { missionId: missionId as unknown as string, runId: runId as unknown as string };
  });
}

/**
 * These queries back the Activity view. A live proof run caught them throwing
 * `ReturnsValidationError` because they returned raw documents (with
 * `_creationTime` and other table-only fields) against a narrow view validator
 * — the UI silently showed "no run" instead of an error. Return validators are
 * contracts, so they are asserted here rather than assumed.
 */
describe("run queries — public return contracts", () => {
  it("runs.forMission returns a valid run view for the mission", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t);
    const run = await t.query(api.runs.forMission, { missionId: missionId as never });
    expect(run).not.toBeNull();
    expect(run?.status).toBe("queued");
    expect(run?.currentStage).toBe("intake");
    expect(typeof run?.retryCount).toBe("number");
    // The raw document's table-only fields must not leak into the view.
    expect(Object.keys(run ?? {})).not.toContain("_creationTime");
    expect(Object.keys(run ?? {})).not.toContain("missionId");
  });

  it("runs.forMission returns null for a mission with no run", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId } = await seedMission(t);
    const orphan = await t.run(async (ctx) => {
      const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
      await ctx.db.delete(run!._id);
      return missionId;
    });
    expect(await t.query(api.runs.forMission, { missionId: orphan as never })).toBeNull();
  });

  it("runs.events returns a valid event trail", async () => {
    const t = convexTest(schema, convexModules);
    const { runId } = await seedMission(t);
    const events = await t.query(api.runs.events, { runId: runId as never });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("mission.created");
    expect(events[0].stage).toBe("intake");
    expect(Object.keys(events[0])).not.toContain("_creationTime");
  });

  it("runs.steps returns a valid agent transcript, including the tool receipt", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, runId } = await seedMission(t);
    await t.run(async (ctx) => ctx.runMutation(internal.runs.recordStepForAction, {
      missionId: missionId as never,
      stage: "discover",
      label: "form.scouted",
      summary: "Scouted 7 field(s).",
      reference: null,
      errorCode: null,
      tool: "firecrawl.scout",
    }));
    const steps = await t.query(api.runs.steps, { runId: runId as never });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label: "form.scouted", stage: "discover", tool: "firecrawl.scout" });
    expect(Object.keys(steps[0])).not.toContain("_creationTime");
    expect(Object.keys(steps[0])).not.toContain("runId");
  });
});
