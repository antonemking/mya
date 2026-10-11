/**
 * Runs retrieval arms over the queries `prepare.mjs` wrote. Each arm returns
 * up to 30 ranked chunk ids per query into data/results/<arm>.jsonl. Reruns
 * skip queries already done; --fresh starts an arm over.
 *
 *   bm25              BM25 over the whole corpus, on "<paper title>\n<question>"
 *   bm25-scoped       the same, restricted to the right paper (an oracle, to separate
 *                     finding the paper from finding the passage)
 *   semantic          cosine over OpenAI embeddings of the same text
 *   semantic-scoped   the same, restricted to the right paper
 *   agent             the mya loop with search/grep/read_chunk tools; the model rewrites
 *                     the question into search terms, searches, reads, and submits a ranking.
 *                     Each run is a session file under data/runs/agent/, replayable with mya.
 *   expand            one model call rewrites the question into searches and greps before seeing any
 *                     text, then BM25 and grep run them inside the paper. No reading, no ranking.
 *   agent-queries     the agent's recorded search and grep calls replayed with no model, fused by
 *                     reciprocal rank: what the expanded terms alone buy, without the model reading
 *   <arm>+jev         the top 30 of <arm>, reranked by one Jev Noul per pair
 *
 *   node experiments/search-eval/run.mjs --limit 20
 *   node experiments/search-eval/run.mjs --arms agent,agent+jev --concurrency 4 --provider openai-codex
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Agent, JsonlSession } from "pi-agent";
import { createModelClient } from "pi-ai";
import { rerank } from "pi-jev";
import { grep, indexText, loadCorpus, search } from "pi-search";
import { DirCache, appendJsonl, cosine, embed, loadEnv, mapPool, parseArgs, paths, readJsonl, resolveProvider, scoreRanking } from "./lib.mjs";

loadEnv();
const flags = parseArgs();
const POOL = 30;
const DEFAULT_ARMS = "bm25,bm25-scoped,semantic,semantic-scoped,expand,agent,agent-queries,bm25+jev,semantic+jev,agent+jev";
const requested = String(flags.arms ?? DEFAULT_ARMS).split(",").filter(Boolean);
const stage = (arm) => (arm.endsWith("+jev") ? 2 : arm === "agent-queries" ? 1 : 0);
const arms = [...requested].sort((a, b) => stage(a) - stage(b));
const limit = flags.limit ? Number(flags.limit) : Infinity;
const concurrency = Number(flags.concurrency ?? 4);

const corpus = await loadCorpus(paths.corpus);
const queries = roundRobin(await readJsonl(paths.queries)).slice(0, limit);
const queryText = (q) => `${q.paper}\n${q.question}`;

/** One query per paper in turn, so --limit samples across papers instead of exhausting the first few. */
function roundRobin(all) {
  const byDoc = new Map();
  for (const q of all) {
    if (!byDoc.has(q.doc)) byDoc.set(q.doc, []);
    byDoc.get(q.doc).push(q);
  }
  const lists = [...byDoc.values()];
  const out = [];
  for (let round = 0; out.length < all.length; round += 1) {
    for (const list of lists) if (list[round]) out.push(list[round]);
  }
  return out;
}

let embeddings;
async function chunkVectors() {
  if (!embeddings) {
    const { vectors, tokens } = await embed(corpus.chunks.map(indexText), { cache: new DirCache(join(paths.cache, "embeddings")) });
    if (tokens > 0) process.stderr.write(`embedded ${corpus.chunks.length} chunks (${tokens} new tokens)\n`);
    embeddings = vectors;
  }
  return embeddings;
}

async function semantic(q, scoped) {
  const vectors = await chunkVectors();
  const { vectors: [query], tokens } = await embed([queryText(q)], { cache: new DirCache(join(paths.cache, "embeddings")) });
  const ranked = corpus.chunks
    .map((chunk, i) => ({ id: chunk.id, doc: chunk.doc, score: cosine(query, vectors[i]) }))
    .filter((hit) => !scoped || hit.doc === q.doc)
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL)
    .map((hit) => hit.id);
  return { ranked, usage: { embeddingTokens: tokens } };
}

const AGENT_SYSTEM = [
  "You are a search agent. The corpus is a set of research papers, parsed from PDF and split into chunks.",
  "Your job is to find the chunks that contain the answer to a question about one paper. Do not answer the question.",
  "",
  "Tools:",
  "- list_documents: document ids and titles.",
  "- search: BM25 keyword search. It matches words, not meaning.",
  "- grep: exact string or regular expression. Good for names, numbers, acronyms, and phrases.",
  "- read_chunk: the full text of chunks.",
  "- submit: your final ranking of chunk ids. Call it once, at the end.",
  "",
  "How to search:",
  "1. Find the paper's document id, then pass it as `doc` so searches stay inside that paper.",
  "2. The question uses the asker's words; the paper uses its own. Rewrite the question into the terms the paper would use:",
  "   technical terms, synonyms, abbreviations and their expansions, dataset, model, and metric names, and the words of the",
  "   section where the answer would live (baselines, experimental setup, results, dataset statistics, annotation).",
  "3. Run several different searches and greps. Read promising chunks before you rank them.",
  "4. Use at most 8 searches. Then call submit with up to 10 chunk ids, most likely first.",
].join("\n");

let agentModelPromise;
const loadAgentModel = () =>
  (agentModelPromise ??= resolveProvider(flags).then(({ provider, model }) => {
    const client = createModelClient(provider);
    process.stderr.write(`agent: ${client.provider} ${model ?? client.defaultModel}\n`);
    return { client, name: model ?? client.defaultModel };
  }));

async function runAgent(q) {
  const agentModel = await loadAgentModel();
  const file = join(paths.runs, "agent", `${q.qid}.jsonl`);
  await rm(file, { force: true });

  let submitted;
  const submit = {
    name: "submit",
    description: "Submit your final ranking: up to 10 chunk ids, most likely to contain the answer first. Ends the search.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
    execute(args) {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
      const known = ids.filter((id) => corpus.chunk(id));
      if (known.length === 0) return { output: "none of those are chunk ids; submit ids like 1912.01214#3", isError: true };
      submitted = known;
      return { output: `submitted ${known.length} chunks`, terminate: true };
    },
  };

  const agent = new Agent({
    model: agentModel.client,
    modelName: agentModel.name,
    tools: [],
    extensions: [search(corpus), { name: "eval", tools: [submit] }],
    session: new JsonlSession({ file }),
    system: AGENT_SYSTEM,
    maxTurns: 15,
  });

  const seen = [];
  const calls = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") calls.push({ name: event.call.name, args: event.call.arguments });
    if (event.type === "tool_execution_end" && event.call.name !== "submit") {
      for (const match of event.outcome.output.matchAll(/\[([^\]\s]+#\d+)\]/g)) {
        if (!seen.includes(match[1])) seen.push(match[1]);
      }
    }
  });

  const result = await agent.run(`Paper: "${q.paper}"\nQuestion: ${q.question}`);
  const ranked = [...new Set([...(submitted ?? []), ...seen])].slice(0, POOL);
  return {
    ranked,
    usage: result.usage,
    meta: {
      reason: result.reason,
      turns: result.turns,
      submitted: submitted?.length ?? 0,
      calls,
      session: file,
      ...(result.error ? { error: result.error.message } : {}),
    },
  };
}

const EXPAND_SYSTEM = [
  "You rewrite a question into search terms for one research paper. You have not read the paper and you will not see any search results.",
  "The question uses the asker's words. Propose the words the paper itself would use: technical terms, synonyms, abbreviations and their",
  "expansions, and the names of datasets, models, metrics, and sections where the answer would be stated.",
  "Call propose once with at most 4 keyword searches and 4 grep patterns (names, numbers, acronyms, short phrases). Do not answer the question.",
].join(" ");

async function runExpand(q) {
  const agentModel = await loadAgentModel();
  const file = join(paths.runs, "expand", `${q.qid}.jsonl`);
  await rm(file, { force: true });

  let proposed = { searches: [], greps: [] };
  const propose = {
    name: "propose",
    description: "Record keyword searches and grep patterns. Call once. Ends the turn.",
    parameters: {
      type: "object",
      properties: {
        searches: { type: "array", items: { type: "string" }, description: "Up to 4 BM25 keyword queries." },
        greps: { type: "array", items: { type: "string" }, description: "Up to 4 literal strings or phrases." },
      },
      required: ["searches", "greps"],
      additionalProperties: false,
    },
    execute(args) {
      proposed = { searches: stringList(args.searches, 4), greps: stringList(args.greps, 4) };
      if (proposed.searches.length + proposed.greps.length === 0) {
        return { output: "propose at least one search or grep", isError: true };
      }
      return { output: `recorded ${proposed.searches.length} searches and ${proposed.greps.length} greps`, terminate: true };
    },
  };

  const agent = new Agent({
    model: agentModel.client,
    modelName: agentModel.name,
    tools: [],
    extensions: [{ name: "expand", tools: [propose] }],
    session: new JsonlSession({ file }),
    system: EXPAND_SYSTEM,
    maxTurns: 2,
  });
  const result = await agent.run(`Paper: "${q.paper}"\nQuestion: ${q.question}`);
  const calls = [
    { name: "search", args: { query: q.question, doc: q.doc } },
    ...proposed.searches.map((query) => ({ name: "search", args: { query, doc: q.doc } })),
    ...proposed.greps.map((pattern) => ({ name: "grep", args: { pattern, doc: q.doc } })),
  ];
  return {
    ranked: fuseCalls(calls),
    usage: result.usage,
    meta: { reason: result.reason, turns: result.turns, proposed, session: file, ...(result.error ? { error: result.error.message } : {}) },
  };
}

function stringList(value, max) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()).slice(0, max);
}

function replayAgentQueries(agentResult) {
  return fuseCalls(agentResult.meta.calls);
}

function fuseCalls(calls) {
  const lists = [];
  for (const call of calls) {
    const doc = call.args.doc || undefined;
    if (call.name === "search" && typeof call.args.query === "string") {
      lists.push(corpus.bm25(call.args.query, { limit: POOL, ...(doc ? { doc } : {}) }).map((h) => h.id));
    } else if (call.name === "grep" && typeof call.args.pattern === "string") {
      try {
        const hits = grep(corpus.chunks, call.args.pattern, {
          regex: Boolean(call.args.regex),
          caseSensitive: Boolean(call.args.case_sensitive),
          limit: corpus.chunks.length,
          ...(doc ? { doc } : {}),
        });
        lists.push(hits.sort((a, b) => b.matches - a.matches).slice(0, POOL).map((h) => h.id));
      } catch {
        // The agent saw this pattern fail too.
      }
    }
  }
  const fused = new Map();
  for (const list of lists) for (const [rank, id] of list.entries()) fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1));
  return [...fused].sort((a, b) => b[1] - a[1]).slice(0, POOL).map(([id]) => id);
}

async function jev(q, baseArm, baseResults) {
  const base = baseResults.get(q.qid);
  if (!base) throw new Error(`no ${baseArm} result for ${q.qid}; run ${baseArm} first`);
  const candidates = base.ranked.slice(0, POOL).map((id) => {
    const chunk = corpus.chunk(id);
    return { id, text: chunk.text, title: chunk.title, ...(chunk.section ? { section: chunk.section } : {}) };
  });
  const { ranked, usage } = await rerank({ paper: q.paper, text: q.question }, candidates, {
    cache: new DirCache(join(paths.cache, "jev")),
    concurrency: 8,
  });
  return { ranked: ranked.map((r) => r.id), usage, meta: { nouls: ranked.map((r) => [r.id, Number(r.noul.toFixed(4))]) } };
}

for (const arm of arms) {
  const file = join(paths.results, `${arm}.jsonl`);
  if (flags.fresh) await rm(file, { force: true });
  const done = new Set((await readJsonl(file)).map((r) => r.qid));
  const todo = queries.filter((q) => !done.has(q.qid));
  if (todo.length === 0) {
    process.stderr.write(`${arm}: ${done.size} done\n`);
    continue;
  }

  let run;
  let width = concurrency;
  if (arm.endsWith("+jev")) {
    if (!process.env.TYPESAFE_API_KEY) {
      process.stderr.write(`${arm}: skipped, TYPESAFE_API_KEY is not set\n`);
      continue;
    }
    const baseArm = arm.slice(0, -"+jev".length);
    const baseResults = new Map((await readJsonl(join(paths.results, `${baseArm}.jsonl`))).map((r) => [r.qid, r]));
    run = (q) => jev(q, baseArm, baseResults);
  } else if (arm === "bm25" || arm === "bm25-scoped") {
    const scoped = arm === "bm25-scoped";
    run = async (q) => ({ ranked: corpus.bm25(queryText(q), { limit: POOL, ...(scoped ? { doc: q.doc } : {}) }).map((h) => h.id) });
    width = 1;
  } else if (arm === "semantic" || arm === "semantic-scoped") {
    if (!process.env.OPENAI_API_KEY) {
      process.stderr.write(`${arm}: skipped, OPENAI_API_KEY is not set\n`);
      continue;
    }
    await chunkVectors();
    run = (q) => semantic(q, arm === "semantic-scoped");
  } else if (arm === "agent") {
    run = runAgent;
  } else if (arm === "expand") {
    run = runExpand;
  } else if (arm === "agent-queries") {
    const agentResults = new Map((await readJsonl(join(paths.results, "agent.jsonl"))).map((r) => [r.qid, r]));
    run = async (q) => {
      const agentResult = agentResults.get(q.qid);
      if (!agentResult?.meta) throw new Error(`no agent result for ${q.qid}; run agent first`);
      return { ranked: replayAgentQueries(agentResult) };
    };
    width = 1;
  } else {
    throw new Error(`unknown arm: ${arm}`);
  }

  let finished = 0;
  let hits = 0;
  await mapPool(todo, width, async (q) => {
    const started = Date.now();
    let record;
    try {
      const out = await run(q);
      record = { qid: q.qid, arm, ...out, ms: Date.now() - started };
    } catch (error) {
      record = { qid: q.qid, arm, ranked: [], ms: Date.now() - started, error: error.message };
    }
    await appendJsonl(file, record);
    finished += 1;
    hits += scoreRanking(record.ranked, q.gold).hit10;
    if (arm === "agent" || arm === "expand" || arm.endsWith("+jev") || finished % 25 === 0 || finished === todo.length) {
      process.stderr.write(
        `${arm} ${finished}/${todo.length} hit@10 so far ${((100 * hits) / finished).toFixed(0)}%${record.error ? ` · error: ${record.error}` : ""}\n`,
      );
    }
  });
}

process.stderr.write(`done. node experiments/search-eval/report.mjs\n`);
