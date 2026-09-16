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

// A run only advances because a stage scheduled its successor or is waiting on
// an external callback. A stage that dies without transitioning would otherwise
// stay `active` forever and be reported as work in progress, so the reaper parks
// abandoned runs (resumable) instead of leaving the command center lying about
// its own state.
crons.interval(
  "stale run reaper",
  { minutes: 10 },
  internal.runReaper.reap,
  {},
);

export default crons;
