/**
 * The representation boundary, enforced on data rather than on prompt wording.
 *
 * Context readiness already separates two things: facts the user confirmed
 * (which Radar may state as the user's own position) and evidence found in the
 * user's documents (which Radar may use to *reason*, but which the user never
 * said). A prompt instruction alone does not hold that line — a model that has
 * just read "5 years of React" in a portfolio will happily sign an email with it.
 *
 * So this is a deterministic check on the finished draft. It looks for
 * first-person assertions about the sender, and flags any that lean on a term
 * which appears only in the sender's unconfirmed material. It is deliberately
 * narrow:
 *
 *   - It only inspects sentences that assert something about the sender
 *     ("I have…", "My experience…", "5 years of…"). A sentence about the
 *     *recipient* is not a claim about the user and is left alone.
 *   - It only compares against the user's own sources. The counterpart's page
 *     content is not consulted, so "I noticed you're hiring" is never flagged
 *     for repeating a word from the recipient's own site.
 *
 * It is a guard against one specific failure — signing the user's name to
 * something they never confirmed — not a general fact-checker, and the repair
 * path treats a flag as a rewrite request rather than an accusation.
 */

export type GuardInput = {
  /** Facts the user confirmed: the only material a message may assert. */
  authorizedFacts: Array<{ category: string; value: string }>;
  /** The sender's own documents — reasoning only, never a claim. */
  reasoningSources: Array<{ title: string; text: string }>;
};

/** Sentences that assert something about the sender, rather than the recipient. */
const CLAIM_PATTERNS: RegExp[] = [
  /\bi\s+(?:have|had|bring|offer|provide|speciali[sz]e|led|built|shipped|delivered|managed|worked|run|own|founded|studied)\b/i,
  /\bi'?ve\s+(?:built|led|shipped|delivered|worked|spent|managed|run|been)\b/i,
  /\bi'?m\s+an?\s+\w/i,
  /\bi\s+am\s+an?\s+\w/i,
  /\bmy\s+(?:experience|background|work|portfolio|team|company|studio|agency|clients|projects)\b/i,
  /\b\d+\+?\s+years?\s+(?:of\s+)?\w/i,
];

const WEAK_TERMS = new Set([
  "that", "this", "with", "from", "your", "have", "been", "they", "them", "their",
  "would", "could", "should", "about", "there", "where", "which", "while", "when",
  "years", "year", "experience", "background", "projects", "project", "work",
  "team", "company", "companies", "clients", "please", "hello", "thank", "thanks",
  "would", "love", "hope", "best", "regards", "help", "helping", "looking",
]);

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    // Five characters or more: shorter words are too common to carry a claim.
    if (word.length >= 5 && !WEAK_TERMS.has(word) && !/^\d+$/.test(word)) out.add(word);
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Returns the sentences that assert something about the sender using material
 * the user never confirmed. Empty means the draft is safe to show.
 */
export function ungroundedClaims(body: string, input: GuardInput): string[] {
  const authorized = terms(input.authorizedFacts.map((fact) => `${fact.category} ${fact.value}`).join(" \n "));
  if (input.reasoningSources.length === 0) return [];

  // Terms that appear in the sender's own sources but never in what they
  // confirmed: exactly the material that must not be asserted on their behalf.
  const unconfirmed = new Set<string>();
  for (const source of input.reasoningSources) {
    for (const term of terms(source.text)) {
      if (!authorized.has(term)) unconfirmed.add(term);
    }
  }
  if (unconfirmed.size === 0) return [];

  const flagged: string[] = [];
  for (const sentence of sentences(body)) {
    if (!CLAIM_PATTERNS.some((pattern) => pattern.test(sentence))) continue;
    const words = terms(sentence);
    for (const word of words) {
      if (unconfirmed.has(word)) {
        flagged.push(sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence);
        break;
      }
    }
  }
  return flagged;
}
