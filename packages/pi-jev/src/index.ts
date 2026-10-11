import { createHash } from "node:crypto";
import { noul, TypeSafeClient, type EntryType, type NoulQuestion } from "@typesafe-ai/sdk";

/**
 * Jev as a reranker: one Noul per (query, candidate) pair, sorted by the
 * probability of yes. It only reorders the candidates it is given; it cannot
 * find a passage that retrieval missed.
 */
export interface RerankCandidate {
  id: string;
  text: string;
  title?: string;
  section?: string;
}

export interface RerankScore {
  id: string;
  noul: number;
  /** Position the candidate had before reranking, 0-based. */
  before: number;
}

export interface JevUsage {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PairRecord {
  model: string;
  state: EntryType;
  noul: number;
  inputTokens: number;
  outputTokens: number;
}

/** Keyed by a hash of model, state, and question, so a rerun replays instead of paying again. */
export interface PairCache {
  get(key: string): Promise<PairRecord | undefined>;
  set(key: string, record: PairRecord): Promise<void>;
}

export interface RerankOptions {
  client?: TypeSafeClient;
  /** Defaults to $TYPESAFE_DEFAULT_MODEL, then `jev-latest`. */
  model?: string;
  question?: NoulQuestion;
  concurrency?: number;
  cache?: PairCache;
  signal?: AbortSignal;
}

export const answersQuestion: NoulQuestion = noul(
  "Does `passage` contain information that answers `question`? " +
    "The question is about one specific paper, named in `question.paper`; a passage from a different paper cannot answer it.",
  {
    true:
      "The passage comes from the paper the question is about, and it states the facts, methods, results, datasets, " +
      "or details that answer the question, fully or in substantial part.",
    false:
      "The passage comes from a different paper, or is only on a related topic, or mentions the question's terms " +
      "without giving the answer.",
  },
);

export async function rerank(
  question: { paper?: string; text: string },
  candidates: RerankCandidate[],
  options: RerankOptions = {},
): Promise<{ ranked: RerankScore[]; usage: JevUsage }> {
  const client = options.client ?? new TypeSafeClient({ timeout: 60_000 });
  const model = options.model ?? client.defaultModel;
  const jevQuestion = options.question ?? answersQuestion;
  const usage: JevUsage = { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 };

  const scores = await mapPool(candidates, options.concurrency ?? 8, async (candidate, before) => {
    const state: EntryType = {
      question: { ...(question.paper ? { paper: question.paper } : {}), text: question.text },
      passage: {
        ...(candidate.title ? { paper: candidate.title } : {}),
        ...(candidate.section ? { section: candidate.section } : {}),
        text: candidate.text,
      },
    };
    const key = createHash("sha256").update(JSON.stringify({ model, state, jevQuestion })).digest("hex");
    let record = await options.cache?.get(key);
    if (record) {
      usage.cachedCalls += 1;
    } else {
      const response = await client.systemOne(
        { model, state, questions: { answers: jevQuestion } },
        options.signal ? { signal: options.signal } : {},
      );
      record = {
        model: response.model,
        state,
        noul: response.answers.answers.noul,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      usage.calls += 1;
      await options.cache?.set(key, record);
    }
    usage.inputTokens += record.inputTokens;
    usage.outputTokens += record.outputTokens;
    return { id: candidate.id, noul: record.noul, before };
  });

  const ranked = [...scores].sort((a, b) => b.noul - a.noul || a.before - b.before);
  return { ranked, usage };
}

async function mapPool<T, R>(items: T[], size: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}
