import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type RunStage = "intake" | "interpret" | "plan" | "plan_review" | "discover" | "check_in" | "evaluate" | "approval" | "execute" | "wait" | "complete";
type RunStatus = "queued" | "active" | "waiting" | "blocked" | "complete" | "failed" | "cancelled";
type MissionStatus = "draft" | "ready" | "running" | "waiting" | "blocked" | "complete" | "failed" | "expired" | "cancelled";

const allowedNextStages: Record<RunStage, RunStage[]> = {
  intake: ["interpret", "plan", "plan_review", "discover", "approval", "wait", "complete"],
  interpret: ["plan", "plan_review", "discover", "approval", "wait", "complete"],
  plan: ["plan_review", "discover", "evaluate", "approval", "wait", "complete"],
  plan_review: ["discover", "evaluate", "approval", "wait", "complete"],
  discover: ["check_in", "evaluate", "approval", "wait", "complete"],
  check_in: ["evaluate", "discover", "approval", "wait", "complete"],
  evaluate: ["discover", "check_in", "approval", "execute", "wait", "complete"],
  approval: ["execute", "wait", "complete"],
  execute: ["approval", "wait", "complete"],
  wait: ["discover", "evaluate", "approval", "execute", "complete"],
  complete: [],
};

function missionStatusForRun(status: RunStatus): MissionStatus {
  switch (status) {
    case "queued": return "ready";
    case "active": return "running";
    case "waiting": return "waiting";
    case "blocked": return "blocked";
    case "complete": return "complete";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
  }
}

export async function transitionRun(
  ctx: MutationCtx,
  args: {
    missionId: Id<"missions">;
    targetStage: RunStage;
    targetStatus: RunStatus;
    interruption: string | null;
    eventType: string;
    safeSummary: string;
  },
) {
  const run = await ctx.db
    .query("agentRuns")
    .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
    .first();
  const mission = await ctx.db.get(args.missionId);
  if (!run || !mission) throw new Error("Mission run not found");

  const sameState = run.currentStage === args.targetStage && run.status === args.targetStatus;
  if (!sameState && run.currentStage !== args.targetStage && !allowedNextStages[run.currentStage].includes(args.targetStage)) {
    throw new Error(`RUN_NOT_RESUMABLE: cannot move from ${run.currentStage} to ${args.targetStage}.`);
  }

  if (sameState) return { runId: run._id, status: run.status, currentStage: run.currentStage, changed: false };

  const now = Date.now();
  const startedAt = run.startedAt ?? (args.targetStatus === "active" ? now : null);
  const finishedAt = ["complete", "failed", "cancelled"].includes(args.targetStatus) ? now : null;
  await ctx.db.patch(run._id, {
    status: args.targetStatus,
    currentStage: args.targetStage,
    checkpointVersion: run.checkpointVersion + 1,
    activeInterruption: args.interruption,
    nextWakeAt: null,
    startedAt,
    finishedAt,
    updatedAt: now,
  });
  await ctx.db.patch(mission._id, { status: missionStatusForRun(args.targetStatus), updatedAt: now });
  await ctx.db.insert("runEvents", {
    missionId: args.missionId,
    runId: run._id,
    type: args.eventType,
    stage: args.targetStage,
    safeSummary: args.safeSummary,
    createdAt: now,
  });
  return { runId: run._id, status: args.targetStatus, currentStage: args.targetStage, changed: true };
}
