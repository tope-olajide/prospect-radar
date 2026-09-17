/**
 * Text chunking for user-supplied data sources.
 *
 * Pure functions (no Convex imports) so they are unit-testable. The agent reads
 * bounded chunks, never whole documents — the same discipline applied to
 * untrusted web content, applied here to the user's own files for a different
 * reason: prompts have finite context, and retrieval over chunks lets mission
 * planning pull only the passages relevant to the goal.
 */

/** Target chunk size in characters. Small enough that ~8 chunks fit a prompt. */
const CHUNK_SIZE = 1200;

/** Overlap between consecutive chunks, so a fact split across a boundary survives. */
const CHUNK_OVERLAP = 150;

/** Hard ceiling on one stored chunk — bounded even if the constants drift. */
const MAX_CHUNK = CHUNK_SIZE + CHUNK_OVERLAP;

/** A source may hold at most this many chunks; anything past it is ignored. */
export const MAX_CHUNKS_PER_SOURCE = 80;

/** Normalize whitespace and clamp a document to a sane ingest size. */
export function normalizeDocument(text: string, maxChars = 200_000): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
}

/**
 * Split normalized text into overlapping chunks on paragraph boundaries where
 * possible. Deterministic: the same input always yields the same chunks.
 */
export function chunkText(text: string): string[] {
  const clean = normalizeDocument(text);
  if (!clean) return [];
  if (clean.length <= MAX_CHUNK) return [clean];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    let end = Math.min(cursor + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence end, then a word boundary.
      const window = clean.slice(cursor, end);
      const paragraphBreak = window.lastIndexOf("\n\n");
      const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      const wordBreak = window.lastIndexOf(" ");
      if (paragraphBreak > CHUNK_SIZE * 0.5) end = cursor + paragraphBreak + 1;
      else if (sentenceBreak > CHUNK_SIZE * 0.5) end = cursor + sentenceBreak + 1;
      else if (wordBreak > CHUNK_SIZE * 0.5) end = cursor + wordBreak + 1;
    }
    const chunk = clean.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP, cursor + 1);
  }
  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
}

/** The indexed form of a chunk: lowercase, whitespace-collapsed, bounded. */
export function toSearchText(chunk: string): string {
  return chunk.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 4000);
}

/** Display summary: the first line or sentence of the document, bounded. */
export function documentSummary(text: string, maxChars = 180): string {
  const clean = normalizeDocument(text, 2000);
  const firstLine = clean.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.slice(0, maxChars);
}

/** Extremes-only text extraction from a raw PDF/DOCX buffer (metadata-free view). */
export function extractPrintableText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  let run = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const printable = (byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9;
    if (printable) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= 6) out += (out ? " " : "") + run;
      run = "";
    }
  }
  if (run.length >= 6) out += (out ? " " : "") + run;
  return out;
}
