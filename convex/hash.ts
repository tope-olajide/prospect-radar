export async function contentHash(
  recipient: string,
  subject: string,
  body: string,
  capability = "send_email",
) {
  const canonical = JSON.stringify({ capability, recipient: recipient.trim(), subject: subject.trim(), body });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function boundedText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
