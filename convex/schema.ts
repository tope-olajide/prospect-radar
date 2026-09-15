import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const missionMode = v.union(v.literal("opportunity"), v.literal("person"), v.literal("customer"), v.literal("solution"), v.literal("collaborator"));
const missionStatus = v.union(v.literal("draft"), v.literal("ready"), v.literal("running"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("expired"), v.literal("cancelled"));
const runStatus = v.union(v.literal("queued"), v.literal("active"), v.literal("waiting"), v.literal("blocked"), v.literal("complete"), v.literal("failed"), v.literal("cancelled"));
const runStage = v.union(v.literal("intake"), v.literal("interpret"), v.literal("plan"), v.literal("discover"), v.literal("evaluate"), v.literal("approval"), v.literal("execute"), v.literal("wait"), v.literal("complete"));

export default defineSchema({
  missions: defineTable({
    workspaceId: v.string(), title: v.string(), rawGoal: v.string(), mode: missionMode,
    status: missionStatus, constraints: v.array(v.string()), sourceScope: v.string(),
    completionPredicate: v.string(), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_workspaceId", ["workspaceId"]).index("by_workspaceId_and_status", ["workspaceId", "status"]),
  agentRuns: defineTable({
    missionId: v.id("missions"), status: runStatus, currentStage: runStage,
    checkpointVersion: v.number(), activeInterruption: v.union(v.string(), v.null()),
    nextWakeAt: v.union(v.number(), v.null()), retryCount: v.number(),
    startedAt: v.union(v.number(), v.null()), finishedAt: v.union(v.number(), v.null()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_missionId", ["missionId"]),
  runEvents: defineTable({
    missionId: v.id("missions"), runId: v.id("agentRuns"), type: v.string(),
    stage: runStage, safeSummary: v.string(), createdAt: v.number(),
  }).index("by_runId", ["runId"]).index("by_missionId", ["missionId"]),
});
