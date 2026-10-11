import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bm25Index, type Bm25Hit } from "./bm25.js";

/** One searchable passage. Ids look like `<doc>#<n>`. */
export interface Chunk {
  id: string;
  doc: string;
  title: string;
  /** Nearest heading above the passage, when the parser found one. */
  section?: string;
  /** 1-based page the passage starts on. */
  page: number;
  text: string;
}

export interface DocumentInfo {
  id: string;
  title: string;
  source: string;
  pages: number;
  chunks: number;
}

export const CHUNKS_FILE = "chunks.jsonl";
export const DOCUMENTS_FILE = "documents.json";

/** What BM25, embeddings, and rerankers all read, so every method sees the same passage. */
export function indexText(chunk: Chunk): string {
  return [chunk.title, chunk.section, chunk.text].filter(Boolean).join("\n");
}

export class SearchCorpus {
  readonly chunks: Chunk[];
  readonly documents: DocumentInfo[];
  readonly #byId: Map<string, Chunk>;
  #bm25: Bm25Index | undefined;

  constructor(chunks: Chunk[], documents: DocumentInfo[]) {
    this.chunks = chunks;
    this.documents = documents;
    this.#byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  }

  chunk(id: string): Chunk | undefined {
    return this.#byId.get(id);
  }

  bm25(query: string, options: { limit?: number; doc?: string } = {}): Bm25Hit[] {
    this.#bm25 ??= new Bm25Index(this.chunks.map((chunk) => ({ id: chunk.id, text: indexText(chunk) })));
    const doc = options.doc;
    return this.#bm25.search(query, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(doc ? { filter: (id: string) => this.#byId.get(id)?.doc === doc } : {}),
    });
  }
}

export async function writeCorpus(dir: string, chunks: Chunk[], documents: DocumentInfo[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CHUNKS_FILE), chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(""), "utf8");
  await writeFile(join(dir, DOCUMENTS_FILE), `${JSON.stringify(documents, null, 2)}\n`, "utf8");
}

export async function loadCorpus(dir: string): Promise<SearchCorpus> {
  const text = await readFile(join(dir, CHUNKS_FILE), "utf8").catch(() => {
    throw new Error(`no search corpus at ${dir}: ${CHUNKS_FILE} is missing`);
  });
  const chunks = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Chunk);
  const documents = JSON.parse(await readFile(join(dir, DOCUMENTS_FILE), "utf8").catch(() => "[]")) as DocumentInfo[];
  return new SearchCorpus(chunks, documents);
}
