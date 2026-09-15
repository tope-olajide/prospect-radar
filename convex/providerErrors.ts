/**
 * Provider error classification, aligned with docs/data-api.md §7 error
 * classes. Every provider failure that reaches a user surface carries one of
 * these codes so the UI can state what happened, whether retrying makes
 * sense, and what to do next — instead of leaking raw provider text.
 */

export type ProviderErrorCode =
  | "FIRECRAWL_RATE_LIMITED"
  | "FIRECRAWL_CREDITS_EXHAUSTED"
  | "SOURCE_UNAVAILABLE"
  | "AGENTMAIL_DELIVERY_FAILED"
  | "AGENTMAIL_WEBHOOK_INVALID"
  | "OPENAI_SCHEMA_INVALID"
  | "OPENAI_REFUSAL"
  | "PROVIDER_ERROR";

export type ClassifiedError = {
  code: ProviderErrorCode;
  /** User-safe message; never includes raw provider payloads. */
  summary: string;
  /** Whether repeating the same request may succeed. */
  retryable: boolean;
  /** What the user should do next. */
  nextAction: string;
};

/** Ordered patterns; first match wins. */
const patterns: Array<{ code: ProviderErrorCode; test: RegExp; retryable: boolean; summary: string; nextAction: string }> = [
  {
    code: "FIRECRAWL_CREDITS_EXHAUSTED",
    test: /(credit|payment required|plan limit|quota exhausted)/i,
    retryable: false,
    summary: "Firecrawl reports the workspace's crawl credits are exhausted.",
    nextAction: "Add credits or upgrade the Firecrawl plan, then retry the research step.",
  },
  {
    code: "FIRECRAWL_RATE_LIMITED",
    test: /(rate limit|too many requests|\b429\b|temporarily|try again)/i,
    retryable: true,
    summary: "Firecrawl is rate-limiting requests right now.",
    nextAction: "Wait a moment and retry the same research step.",
  },
  {
    code: "SOURCE_UNAVAILABLE",
    test: /(not found|\b404\b|\b410\b|timeout|timed out|dns|econnrefused|enotfound|unreachable|forbidden|\b403\b|unauthorized|\b401\b|robots|blocked)/i,
    retryable: true,
    summary: "The target page could not be fetched from the public web.",
    nextAction: "Retry once; if it keeps failing, drop this source and continue with the others.",
  },
  {
    code: "OPENAI_REFUSAL",
    test: /(refus|content_policy|safety)/i,
    retryable: false,
    summary: "The model declined this request on policy grounds.",
    nextAction: "Rephrase the mission goal; the strict trust rules stay in place.",
  },
  {
    code: "OPENAI_SCHEMA_INVALID",
    test: /(schema|json|parse|unexpected format|no structured|no usable|no classification)/i,
    retryable: true,
    summary: "The model response did not match the required structured format.",
    nextAction: "Retry; repeated failures are surfaced instead of saved as data.",
  },
  {
    code: "AGENTMAIL_WEBHOOK_INVALID",
    test: /(webhook.*(signature|invalid|unauthorized)|svix)/i,
    retryable: false,
    summary: "An inbound webhook failed signature verification and was rejected.",
    nextAction: "Confirm AGENTMAIL_WEBHOOK_SECRET matches the AgentMail dashboard configuration.",
  },
  {
    code: "AGENTMAIL_DELIVERY_FAILED",
    test: /(bounce|bounced|rejected|complain|undeliver|delivery|smtp|send failed|failed to send)/i,
    retryable: false,
    summary: "AgentMail could not deliver the approved message.",
    nextAction: "Check the recipient address and thread state; contact them another way if it persists.",
  },
];

export function classifyProviderError(message: string): ClassifiedError {
  const text = message ?? "";
  for (const pattern of patterns) {
    if (pattern.test.test(text)) {
      return { code: pattern.code, summary: pattern.summary, retryable: pattern.retryable, nextAction: pattern.nextAction };
    }
  }
  return {
    code: "PROVIDER_ERROR",
    summary: "A provider call failed.",
    retryable: true,
    nextAction: "Retry the step; if it persists, check the provider status page.",
  };
}
