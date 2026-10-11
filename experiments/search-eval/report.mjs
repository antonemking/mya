/**
 * Scores every arm in data/results on the queries all of them answered, and
 * writes data/report.md.
 *
 *   node experiments/search-eval/report.mjs
 *   node experiments/search-eval/report.mjs --arms bm25,agent,agent+jev
 */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCorpus } from "pi-search";
import { parseArgs, paths, readJsonl, scoreRanking } from "./lib.mjs";

const flags = parseArgs();
const ORDER = ["bm25", "bm25-scoped", "semantic", "semantic-scoped", "expand", "agent-queries", "agent", "bm25+jev", "expand+jev", "semantic+jev", "agent+jev"];
const available = (await readdir(paths.results).catch(() => []))
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => f.slice(0, -".jsonl".length));
const arms = (flags.arms ? String(flags.arms).split(",") : available).sort(
  (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
);

const queries = new Map((await readJsonl(paths.queries)).map((q) => [q.qid, q]));
const corpus = await loadCorpus(paths.corpus);
const results = {};
for (const arm of arms) {
  results[arm] = new Map((await readJsonl(join(paths.results, `${arm}.jsonl`))).filter((r) => !r.error).map((r) => [r.qid, r]));
}
const common = [...queries.keys()].filter((qid) => arms.every((arm) => results[arm].has(qid)));
if (common.length === 0) {
  console.error("no query has a result from every arm yet");
  process.exit(1);
}

const scores = {};
for (const arm of arms) scores[arm] = common.map((qid) => scoreRanking(results[arm].get(qid).ranked, queries.get(qid).gold));

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x) => `${(100 * x).toFixed(1)}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function usageCell(arm) {
  const rs = common.map((qid) => results[arm].get(qid));
  if (arm === "agent" || arm === "expand") {
    const input = mean(rs.map((r) => r.usage?.inputTokens ?? 0));
    const cached = mean(rs.map((r) => r.usage?.cachedInputTokens ?? 0));
    const output = mean(rs.map((r) => r.usage?.outputTokens ?? 0));
    return `LLM ${Math.round(input + cached)} in (${Math.round(cached)} cached) / ${Math.round(output)} out`;
  }
  if (arm.endsWith("+jev")) return `Jev ${Math.round(mean(rs.map((r) => r.usage?.inputTokens ?? 0)))} in, ${Math.round(mean(rs.map((r) => (r.usage?.calls ?? 0) + (r.usage?.cachedCalls ?? 0))))} calls`;
  if (arm.startsWith("semantic")) return "1 query embedding";
  if (arm === "agent-queries") return "replay, no model";
  return "—";
}

const lines = [];
lines.push("# Search experiment", "");
lines.push(
  `${corpus.documents.length} QASPER papers parsed by LiteParse into ${corpus.chunks.length} chunks. ` +
    `${common.length} queries scored on every arm (of ${queries.size} labelled). ` +
    "Relevance is binary: a chunk is gold if it holds a human-marked evidence paragraph.",
  "",
);
lines.push("| arm | Hit@1 | Hit@5 | Hit@10 | Recall@10 | MRR@10 | nDCG@10 | Hit@30 | median ms | cost per query |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
for (const arm of arms) {
  const s = scores[arm];
  const ms = median(common.map((qid) => results[arm].get(qid).ms));
  lines.push(
    `| ${arm} | ${pct(mean(s.map((x) => x.hit1)))} | ${pct(mean(s.map((x) => x.hit5)))} | ${pct(mean(s.map((x) => x.hit10)))} | ` +
      `${pct(mean(s.map((x) => x.recall10)))} | ${mean(s.map((x) => x.mrr10)).toFixed(3)} | ${mean(s.map((x) => x.ndcg10)).toFixed(3)} | ` +
      `${pct(mean(s.map((x) => x.hit30)))} | ${ms} | ${usageCell(arm)} |`,
  );
}
/** Chance of a gold chunk at rank 1 and in the top 10 if the right paper's chunks were shuffled. */
const chunksPerDoc = new Map();
for (const chunk of corpus.chunks) chunksPerDoc.set(chunk.doc, (chunksPerDoc.get(chunk.doc) ?? 0) + 1);
const randomHit = (n, g, k) => {
  let miss = 1;
  for (let i = 0; i < Math.min(k, n); i += 1) miss *= Math.max(0, n - g - i) / (n - i);
  return 1 - miss;
};
const chance = common.map((qid) => {
  const q = queries.get(qid);
  const n = chunksPerDoc.get(q.doc);
  return { hit1: q.gold.length / n, hit10: randomHit(n, q.gold.length, 10) };
});
lines.push(
  "",
  `Shuffling the right paper's chunks would give Hit@1 ${pct(mean(chance.map((c) => c.hit1)))} and Hit@10 ${pct(mean(chance.map((c) => c.hit10)))}: ` +
    `papers average ${(corpus.chunks.length / corpus.documents.length).toFixed(0)} chunks, and every chunk carries its paper's title, which the query also names, ` +
    "so finding the paper is easy and the test is ranking passages within it.",
  "",
  "Hit@30 is the ceiling for a `+jev` arm: Jev reorders the top 30 and cannot add a chunk retrieval missed.",
  "",
);

/** Paired bootstrap on per-query MRR@10, seeded so the report is reproducible. */
function compare(a, b) {
  const da = scores[a].map((x) => x.mrr10);
  const db = scores[b].map((x) => x.mrr10);
  const diffs = da.map((x, i) => db[i] - x);
  let state = 12345;
  const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
  const samples = [];
  for (let i = 0; i < 2000; i += 1) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j += 1) sum += diffs[Math.floor(random() * diffs.length)];
    samples.push(sum / diffs.length);
  }
  samples.sort((x, y) => x - y);
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const lo = samples[Math.floor(0.025 * samples.length)];
  const hi = samples[Math.floor(0.975 * samples.length)];
  return `| ${b} vs ${a} | ${mean(diffs) >= 0 ? "+" : ""}${mean(diffs).toFixed(3)} | [${lo.toFixed(3)}, ${hi.toFixed(3)}] | ${wins} / ${losses} / ${diffs.length - wins - losses} |`;
}

const pairs = [
  ["bm25", "expand"],
  ["expand", "agent-queries"],
  ["bm25", "agent-queries"],
  ["agent-queries", "agent"],
  ["bm25", "agent"],
  ["semantic", "agent"],
  ["bm25-scoped", "agent"],
  ["bm25", "semantic"],
  ["bm25", "bm25+jev"],
  ["expand", "expand+jev"],
  ["bm25+jev", "expand+jev"],
  ["semantic", "semantic+jev"],
  ["agent", "agent+jev"],
  ["semantic+jev", "agent+jev"],
].filter(([a, b]) => arms.includes(a) && arms.includes(b));
if (pairs.length > 0) {
  lines.push("## Paired differences", "", "| comparison | ΔMRR@10 | 95% CI | better / worse / same |", "| --- | ---: | --- | --- |");
  for (const [a, b] of pairs) lines.push(compare(a, b));
  lines.push("");
}

if (arms.includes("expand")) {
  const rs = common.map((qid) => results.expand.get(qid));
  const proposed = (r) => r.meta?.proposed ?? { searches: [], greps: [] };
  lines.push("## Blind expansion", "");
  lines.push(
    `One model call, before any retrieval, then BM25 and grep inside the named paper. The question itself is one of the BM25 searches. ` +
      `Per query: ${mean(rs.map((r) => proposed(r).searches.length)).toFixed(1)} extra searches and ${mean(rs.map((r) => proposed(r).greps.length)).toFixed(1)} greps.`,
    "",
  );
  lines.push("First ten (gold rank: bm25 → expand → agent-queries):", "");
  for (const qid of common.slice(0, 10)) {
    const q = queries.get(qid);
    const r = results.expand.get(qid);
    const rank = (arm) => {
      if (!results[arm]?.has(qid)) return "–";
      const i = results[arm].get(qid).ranked.findIndex((id) => q.gold.includes(id));
      return i === -1 ? "miss" : String(i + 1);
    };
    const p = proposed(r);
    const terms = [...p.searches.map((s) => `search "${s}"`), ...p.greps.map((g) => `grep /${g}/`)];
    lines.push(`- **${q.question}** (${rank("bm25")} → ${rank("expand")} → ${rank("agent-queries")}) — ${terms.join(" · ") || "no proposals"}`);
  }
  lines.push("");
}

if (arms.includes("agent")) {
  const rs = common.map((qid) => results.agent.get(qid));
  const count = (r, name) => r.meta.calls.filter((c) => c.name === name).length;
  lines.push("## How the agent searched", "");
  lines.push(
    `Per query, on average: ${mean(rs.map((r) => r.meta.turns)).toFixed(1)} turns, ` +
      `${mean(rs.map((r) => count(r, "search"))).toFixed(1)} BM25 searches, ${mean(rs.map((r) => count(r, "grep"))).toFixed(1)} greps, ` +
      `${mean(rs.map((r) => count(r, "read_chunk"))).toFixed(1)} reads. ` +
      `${rs.filter((r) => r.meta.submitted > 0).length}/${rs.length} runs ended in submit` +
      (rs.some((r) => r.meta.submitted === 0) ? "; the rest were ranked by what their searches returned." : "."),
    "",
  );
  lines.push("Query rewrites, first ten queries (gold rank in parentheses: bm25 → agent):", "");
  for (const qid of common.slice(0, 10)) {
    const q = queries.get(qid);
    const r = results.agent.get(qid);
    const rank = (arm) => {
      if (!results[arm]?.has(qid)) return "–";
      const i = results[arm].get(qid).ranked.findIndex((id) => q.gold.includes(id));
      return i === -1 ? "miss" : String(i + 1);
    };
    const searches = r.meta.calls
      .filter((c) => c.name === "search" || c.name === "grep")
      .map((c) => (c.name === "search" ? `search "${c.args.query}"` : `grep /${c.args.pattern}/`));
    lines.push(`- **${q.question}** (${rank("bm25")} → ${rank("agent")}) — ${searches.join(" · ") || "no searches"} · \`${r.meta.session}\``);
  }
  lines.push("");
}

const qs = common.map((qid) => queries.get(qid));
lines.push(
  "## Labels",
  "",
  `${qs.reduce((n, q) => n + q.evidenceLocated, 0)}/${qs.reduce((n, q) => n + q.evidenceTotal, 0)} evidence paragraphs for these queries were found in LiteParse's text; ` +
    "a paragraph that was not found is not gold, so a query with any missing evidence can undercount a correct retrieval.",
  "",
);

const report = lines.join("\n");
await writeFile(paths.report, report, "utf8");
console.log(report);
