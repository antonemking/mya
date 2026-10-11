import type { Chunk } from "./corpus.js";

export interface GrepOptions {
  /** Treat the pattern as a regular expression. Defaults to a literal match. */
  regex?: boolean;
  caseSensitive?: boolean;
  limit?: number;
  doc?: string;
}

export interface GrepHit {
  id: string;
  matches: number;
  /** The first match with some text either side. */
  snippet: string;
}

export function grep(chunks: Chunk[], pattern: string, options: GrepOptions = {}): GrepHit[] {
  const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(source, options.caseSensitive ? "gu" : "giu");
  const limit = options.limit ?? 20;
  const hits: GrepHit[] = [];
  for (const chunk of chunks) {
    if (options.doc && chunk.doc !== options.doc) continue;
    const found = [...chunk.text.matchAll(matcher)];
    if (found.length === 0) continue;
    const first = found[0]!;
    const start = Math.max(0, first.index - 80);
    const end = Math.min(chunk.text.length, first.index + first[0].length + 80);
    const snippet = `${start > 0 ? "…" : ""}${chunk.text.slice(start, end).replace(/\s+/g, " ")}${end < chunk.text.length ? "…" : ""}`;
    hits.push({ id: chunk.id, matches: found.length, snippet });
    if (hits.length >= limit) break;
  }
  return hits;
}
