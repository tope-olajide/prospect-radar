import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Durable schedule (Convex scheduled functions) for the relationship pipeline.
 *
 * The sweep only marks overdue follow-ups and queues sequence drafts — it never
 * sends anything. A step still needs its own approval before it can leave the
 * AgentMail inbox.
 */
const crons = cronJobs();

crons.interval(
  "follow-up sweep",
  { minutes: 15 },
  internal.sequenceRunner.sweepDueFollowUps,
  {},
);

export default crons;
