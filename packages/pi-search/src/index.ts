import { join } from "node:path";
import type { Extension } from "pi-agent";
import { loadCorpus, type SearchCorpus } from "./corpus.js";
import { searchTools } from "./tools.js";

export { Bm25Index } from "./bm25.js";
export type { Bm25Document, Bm25Hit, Bm25Options } from "./bm25.js";
export { CHUNKS_FILE, DOCUMENTS_FILE, SearchCorpus, indexText, loadCorpus, writeCorpus } from "./corpus.js";
export type { Chunk, DocumentInfo } from "./corpus.js";
export { grep } from "./grep.js";
export type { GrepHit, GrepOptions } from "./grep.js";
export { chunkDocument, parseDocument } from "./ingest.js";
export type { ChunkOptions, ParsedDocument, ParsedPage } from "./ingest.js";
export { searchTools } from "./tools.js";
export { tokenize } from "./tokenize.js";

/**
 * Keyword search as tools the model calls. LiteParse has already turned the
 * PDFs into chunks; the model calls BM25 (`search`) and `grep`. Every call is
 * in the event stream and the session. Reranking is a separate extension.
 */
export function search(corpus: SearchCorpus): Extension {
  return { name: "search", tools: searchTools(corpus) };
}

/** `mya -e pi-search` reads the corpus from $MYA_SEARCH_CORPUS, or `.mya/search` in the working directory. */
export default async function searchFromEnv(context: { cwd: string }): Promise<Extension> {
  const dir = process.env.MYA_SEARCH_CORPUS || join(context.cwd, ".mya", "search");
  return search(await loadCorpus(dir));
}
