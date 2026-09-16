import { classifyProviderError, type ClassifiedError } from "./providerErrors";

/**
 * The single retry/backoff policy for orchestrated stages (Phase 6).
 *
 * Before this module the policy was implicit: a retry budget constant in the
 * orchestrator, a hard-coded 30s delay at the call site, and the "is this
 * retryable" decision threaded through `classifyProviderError`. Keeping the
 * three together means a new provider failure can only be classified once and
 * every stage — current and future — inherits the same behaviour.
 *
 * Rules:
 *  - Non-retryable classifications never retry, no matter the attempt count.
 *  - The retry budget is bounded per stage (reset when a stage succeeds).
 *  - Backoff is exponential with a per-code base and a hard ceiling, so a
 *    provider having a bad minute is retried gently instead of hammered.
 *  - Budget exhaustion is not a failure class at all: it parks the run in
 *    `blocked` with a distinct interruption code and resumes on demand.
 */

/** Attempts a stage may retry after its first failure. */
export const MAX_STAGE_RETRIES = 2;

/** Interruption code for a run parked because the workspace ran out of credits. */
export const BUDGET_BLOCKED_INTERRUPTION = "budget_blocked";

/** Interruption code for a run parked because the user stopped it. */
export const CANCELLED_INTERRUPTION = "user_requested";

const DEFAULT_BASE_DELAY_MS = 30_000;
/** Rate limits get a longer cool-off before the first retry. */
const RATE_LIMIT_BASE_DELAY_MS = 60_000;
/** Never wait longer than this between attempts. */
const MAX_DELAY_MS = 10 * 60_000;

/** Whether a classified failure may be retried, given attempts already used. */
export function shouldRetry(classified: ClassifiedError, attemptsUsed: number): boolean {
  return classified.retryable && attemptsUsed < MAX_STAGE_RETRIES;
}

/** Delay before the next attempt: exponential, base keyed on the error class. */
export function retryDelayMs(classified: ClassifiedError, attempt: number): number {
  const base = classified.code === "FIRECRAWL_RATE_LIMITED" ? RATE_LIMIT_BASE_DELAY_MS : DEFAULT_BASE_DELAY_MS;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(base * 2 ** exponent, MAX_DELAY_MS);
}

/** Convenience: classify a raw provider message, then decide. */
export function classifyAndDecide(message: string, attemptsUsed: number) {
  const classified = classifyProviderError(message);
  return {
    classified,
    retry: shouldRetry(classified, attemptsUsed),
    delayMs: retryDelayMs(classified, attemptsUsed + 1),
  };
}

/** How long a successful stage's cost estimate is trusted before re-checking. */
export const BUDGET_CHECK_ENABLED = true;
