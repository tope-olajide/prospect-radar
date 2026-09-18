/** The lifecycle nodes the run can be in, in agent order. */
export const RUN_STAGES = ["intake", "interpret", "plan", "plan_review", "discover", "check_in", "evaluate", "approval", "execute", "complete"] as const;
export type RunStageName = (typeof RUN_STAGES)[number];

const STAGE_COPY: Record<RunStageName, { title: string; doing: string }> = {
  intake: { title: "Receiving your request", doing: "Creating a durable run" },
  interpret: { title: "Understanding your request", doing: "Classifying what you're trying to accomplish" },
  plan: { title: "Planning the approach", doing: "Deciding what to hunt, where, and what evidence counts" },
  plan_review: { title: "Reviewing the plan", doing: "Waiting for you to approve the plan before searching" },
  discover: { title: "Researching", doing: "Searching and crawling public sources for evidence" },
  check_in: { title: "Showing what Radar found", doing: "Presenting discovery results before evaluating" },
  evaluate: { title: "Evaluating matches", doing: "Scoring what it found against your must-haves" },
  approval: { title: "Waiting for you", doing: "Nothing sends until you approve the exact content" },
  execute: { title: "Acting on your approval", doing: "Sending only what you approved" },
  complete: { title: "Mission complete", doing: "Outcome recorded; the relationship stays on the radar" },
};

const STAGE_ORDER: Record<RunStageName, number> = { intake: 0, interpret: 1, plan: 2, plan_review: 3, discover: 4, check_in: 5, evaluate: 6, approval: 7, execute: 8, complete: 9 };

export type RunView = {
  status: string;
  currentStage: string;
  activeInterruption: string | null;
} | null | undefined;

export type StepView = {
  _id: string;
  stage: string;
  label: string;
  summary: string;
  tool?: string | null;
  errorCode?: string | null;
  createdAt: number;
};

function nodeState(run: NonNullable<RunView>, index: number, activeIndex: number): "done" | "active" | "pending" | "failed" {
  const isTerminal = ["complete", "failed", "cancelled"].includes(run.status);
  if (isTerminal) {
    if (run.status === "complete") return index <= activeIndex ? "done" : "pending";
    if (run.status === "failed") return index < activeIndex ? "done" : index === activeIndex ? "failed" : "pending";
    return index < activeIndex ? "done" : "pending"; // cancelled
  }
  return index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
}

function activeNote(run: NonNullable<RunView>, latestStep: StepView | null | undefined): string {
  if (run.status === "queued") return "Ready — start the run and Radar takes it from here";
  if (run.status === "blocked") {
    return run.activeInterruption === "budget_blocked"
      ? "Paused for budget — nothing failed; raise the cap to resume"
      : run.activeInterruption === "stale_run"
        ? "Parked — the run went quiet; resume the stage to continue"
        : "Paused after a failure — retry when ready";
  }
  if (run.status === "waiting") {
    if (run.currentStage === "approval") return "Your approval is the next step";
    if (run.currentStage === "plan_review") return "Review the plan, then approve to start searching";
    if (run.currentStage === "check_in") return "Review what Radar found, then continue to evaluation";
    if (run.currentStage === "intake") return "Radar needs a clarification before it can search";
    return "Waiting on the outside world — Radar continues automatically";
  }
  return latestStep ? latestStep.summary : STAGE_COPY[(run.currentStage as RunStageName) in STAGE_ORDER ? (run.currentStage as RunStageName) : "intake"].doing;
}

/**
 * The agent lifecycle, rendered from real run state.
 *
 * Every node derives from (run.status, run.currentStage): done only if the run
 * has verifiably moved past it, active only if the run is in it right now,
 * pending otherwise. No optimistic updates, no fake progress, no animation —
 * when nothing is running, nothing pulses.
 */
export function MissionLifecycle({
  run,
  latestStep,
}: {
  run: RunView;
  latestStep: StepView | null | undefined;
}) {
  const activeIndex = run
    ? STAGE_ORDER[(run.currentStage as RunStageName) in STAGE_ORDER ? (run.currentStage as RunStageName) : "intake"]
    : -1;

  return (
    <ol className="lifecycle" aria-label="Agent lifecycle">
      {RUN_STAGES.map((stage, index) => {
        const state = run ? nodeState(run, index, activeIndex) : "pending";
        const copy = STAGE_COPY[stage];
        const isActive = state === "active" && run && !["queued"].includes(run.status);
        const waitingHere = isActive && run?.status === "waiting";
        const blockedHere = isActive && run?.status === "blocked";
        return (
          <li
            key={stage}
            className={`lifecycle-node ${state}${waitingHere ? " waiting" : ""}${blockedHere ? " blocked" : ""}`}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="lifecycle-marker" aria-hidden="true" />
            <div className="lifecycle-copy">
              <strong>{copy.title}</strong>
              {state === "active" && (
                <em>{activeNote(run!, latestStep)}{latestStep && run?.status === "active" && latestStep.tool ? ` · ${latestStep.tool}` : ""}</em>
              )}
              {state === "failed" && <em className="lifecycle-error">This stage failed — the transcript below has the reason</em>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
