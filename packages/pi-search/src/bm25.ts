import { tokenize } from "./tokenize.js";

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/** Okapi BM25 over an in-memory postings list. */
export class Bm25Index {
  readonly #ids: string[] = [];
  readonly #lengths: number[] = [];
  readonly #postings = new Map<string, Array<[doc: number, tf: number]>>();
  readonly #k1: number;
  readonly #b: number;
  readonly #averageLength: number;

  constructor(documents: Bm25Document[], options: Bm25Options = {}) {
    this.#k1 = options.k1 ?? 1.2;
    this.#b = options.b ?? 0.75;
    let total = 0;
    for (const [index, document] of documents.entries()) {
      const tokens = tokenize(document.text);
      this.#ids.push(document.id);
      this.#lengths.push(tokens.length);
      total += tokens.length;
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [term, tf] of counts) {
        let list = this.#postings.get(term);
        if (!list) this.#postings.set(term, (list = []));
        list.push([index, tf]);
      }
    }
    this.#averageLength = documents.length === 0 ? 0 : total / documents.length;
  }

  get size(): number {
    return this.#ids.length;
  }

  search(query: string, options: { limit?: number; filter?: (id: string) => boolean } = {}): Bm25Hit[] {
    const limit = options.limit ?? 10;
    const scores = new Map<number, number>();
    const n = this.#ids.length;
    for (const term of new Set(tokenize(query))) {
      const list = this.#postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [doc, tf] of list) {
        const norm = 1 - this.#b + (this.#b * this.#lengths[doc]!) / this.#averageLength;
        const gain = (idf * tf * (this.#k1 + 1)) / (tf + this.#k1 * norm);
        scores.set(doc, (scores.get(doc) ?? 0) + gain);
      }
    }
    const hits: Bm25Hit[] = [];
    for (const [doc, score] of scores) {
      const id = this.#ids[doc]!;
      if (options.filter && !options.filter(id)) continue;
      hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }
}
