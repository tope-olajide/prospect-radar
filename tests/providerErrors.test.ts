import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../convex/providerErrors";

describe("provider error classification (data-api.md §7)", () => {
  it("maps credit exhaustion and marks it non-retryable", () => {
    const result = classifyProviderError("Insufficient credits to perform this request (402).");
    expect(result.code).toBe("FIRECRAWL_CREDITS_EXHAUSTED");
    expect(result.retryable).toBe(false);
  });

  it("maps rate limits as retryable", () => {
    const result = classifyProviderError("429 Too Many Requests: slow down");
    expect(result.code).toBe("FIRECRAWL_RATE_LIMITED");
    expect(result.retryable).toBe(true);
  });

  it("maps unreachable or blocked targets to SOURCE_UNAVAILABLE", () => {
    for (const message of ["404 Not Found", "request timed out after 30000ms", "ENOTFOUND example.com", "403 Forbidden"]) {
      const result = classifyProviderError(message);
      expect(result.code).toBe("SOURCE_UNAVAILABLE");
      expect(result.retryable).toBe(true);
    }
  });

  it("maps delivery failures to AGENTMAIL_DELIVERY_FAILED as non-retryable", () => {
    const result = classifyProviderError("AgentMail reported message.bounced for the approved send.");
    expect(result.code).toBe("AGENTMAIL_DELIVERY_FAILED");
    expect(result.retryable).toBe(false);
  });

  it("maps schema-invalid model output to OPENAI_SCHEMA_INVALID", () => {
    const result = classifyProviderError("Unexpected token in JSON parse of model output");
    expect(result.code).toBe("OPENAI_SCHEMA_INVALID");
  });

  it("falls back to a retryable PROVIDER_ERROR with user-safe copy", () => {
    const result = classifyProviderError("connect ECONNRESET somewhere.internal");
    expect(result.code).toBe("PROVIDER_ERROR");
    expect(result.retryable).toBe(true);
    expect(result.summary).not.toContain("ECONNRESET");
  });
});
