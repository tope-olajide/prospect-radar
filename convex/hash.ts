export async function contentHash(
  recipient: string,
  subject: string,
  body: string,
  capability = "send_email",
  artifactIds: string[] = [],
) {
  // An approval covers the *whole* action, attachments included: approving a
  // message that carries a portfolio is a different act from approving one that
  // does not, so the attachment set is part of the binding. The key is omitted
  // when there is nothing attached, so hashes for attachment-free drafts are
  // unchanged and approvals given before artifacts existed still verify.
  const canonical = JSON.stringify({
    capability,
    recipient: recipient.trim(),
    subject: subject.trim(),
    body,
    ...(artifactIds.length > 0 ? { artifacts: [...new Set(artifactIds)].sort() } : {}),
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function boundedText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Builds the denormalized text a Convex search index reads. Search indexes
 * cover exactly one field, so the fields a user would search across are joined
 * here at write time instead of running a search per field at read time.
 */
export function searchableText(parts: Array<string | null | undefined>, maxLength = 600) {
  return boundedText(parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" \u00b7 "), maxLength);
}
