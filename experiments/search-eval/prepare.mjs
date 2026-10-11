/**
 * Builds the corpus and the labelled queries for the search experiment.
 *
 * Papers and questions come from QASPER's dev split: questions about NLP
 * papers, each answered by evidence paragraphs a human annotator marked. We
 * download each paper's PDF from arXiv, parse it with LiteParse, chunk it, and
 * mark as gold the chunks that contain an evidence paragraph. Evidence that
 * cannot be found in LiteParse's text is counted, not guessed at.
 *
 *   node experiments/search-eval/prepare.mjs --papers 40 --seed 7
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkDocument, parseDocument, writeCorpus } from "pi-search";
import { paths, parseArgs, sleep, writeJsonl } from "./lib.mjs";

const flags = parseArgs();
const PAPERS = Number(flags.papers ?? 40);
const SEED = Number(flags.seed ?? 7);
const TARGET_WORDS = Number(flags["chunk-words"] ?? 200);

const qasper = JSON.parse(
  await readFile(paths.qasper, "utf8").catch(() => {
    throw new Error(
      `missing ${paths.qasper}. Download it first:\n` +
        `  curl -sL https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz | tar xz -C ${paths.data}`,
    );
  }),
);

const PLACEHOLDER = /\b(BIBREF|TABREF|FIGREF|SECREF|EQREF|INLINEFORM|DISPLAYFORM)\d+\b/g;

function evidenceOf(qa) {
  const paragraphs = new Set();
  for (const { answer } of qa.answers) {
    if (answer.unanswerable) continue;
    for (const evidence of answer.evidence) {
      if (evidence.startsWith("FLOAT SELECTED")) continue;
      paragraphs.add(evidence);
    }
  }
  return [...paragraphs].filter((p) => words(p).length >= 8);
}

function shortAnswer(qa) {
  for (const { answer } of qa.answers) {
    if (answer.unanswerable) continue;
    if (answer.extractive_spans.length > 0) return answer.extractive_spans.join("; ");
    if (answer.free_form_answer) return answer.free_form_answer;
    if (answer.yes_no !== null) return answer.yes_no ? "yes" : "no";
  }
  return "";
}

const words = (text) => text.replace(PLACEHOLDER, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function trigrams(text) {
  const w = words(text);
  const set = new Set();
  for (let i = 0; i + 2 < w.length; i += 1) set.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return set;
}

/** Chunks holding at least 15% of a paragraph's trigrams, if together they hold half of it. */
function locate(paragraph, chunkGrams) {
  const grams = trigrams(paragraph);
  if (grams.size === 0) return [];
  const covering = [];
  let total = 0;
  for (const [id, set] of chunkGrams) {
    let shared = 0;
    for (const gram of grams) if (set.has(gram)) shared += 1;
    const coverage = shared / grams.size;
    if (coverage >= 0.15) {
      covering.push(id);
      total += coverage;
    }
  }
  return total >= 0.5 ? covering : [];
}

function shuffled(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function downloadPdf(id) {
  const file = join(paths.pdfs, `${id}.pdf`);
  const existing = await stat(file).catch(() => undefined);
  if (existing && existing.size > 1000) return file;
  const response = await fetch(`https://arxiv.org/pdf/${id}`, {
    headers: { "user-agent": "mya-search-eval (research; https://github.com/)" },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.subarray(0, 4).toString() !== "%PDF") {
    throw new Error(`arXiv ${id}: HTTP ${response.status}, not a PDF`);
  }
  await writeFile(file, bytes);
  await sleep(3000);
  return file;
}

await mkdir(paths.pdfs, { recursive: true });

const candidates = shuffled(Object.keys(qasper).sort(), SEED).filter((id) => qasper[id].qas.some((qa) => evidenceOf(qa).length > 0));

const chunks = [];
const documents = [];
const queries = [];
const stats = { questions: 0, withEvidence: 0, kept: 0, paragraphs: 0, located: 0, parseFailures: [] };

for (const id of candidates) {
  if (documents.length >= PAPERS) break;
  const paper = qasper[id];
  let parsed;
  try {
    const file = await downloadPdf(id);
    parsed = await parseDocument(file, { id, title: paper.title });
  } catch (error) {
    stats.parseFailures.push(`${id}: ${error.message}`);
    process.stderr.write(`skip ${id}: ${error.message}\n`);
    continue;
  }
  const docChunks = chunkDocument(parsed, { targetWords: TARGET_WORDS });
  chunks.push(...docChunks);
  documents.push({ id, title: paper.title, source: `https://arxiv.org/pdf/${id}`, pages: parsed.pages.length, chunks: docChunks.length });

  const chunkGrams = docChunks.map((chunk) => [chunk.id, trigrams(chunk.text)]);
  for (const qa of paper.qas) {
    stats.questions += 1;
    const evidence = evidenceOf(qa);
    if (evidence.length === 0) continue;
    stats.withEvidence += 1;
    const gold = new Set();
    let located = 0;
    for (const paragraph of evidence) {
      stats.paragraphs += 1;
      const ids = locate(paragraph, chunkGrams);
      if (ids.length > 0) {
        located += 1;
        stats.located += 1;
        for (const chunkId of ids) gold.add(chunkId);
      }
    }
    if (gold.size === 0) continue;
    stats.kept += 1;
    queries.push({
      qid: qa.question_id,
      doc: id,
      paper: paper.title,
      question: qa.question,
      answer: shortAnswer(qa),
      gold: [...gold],
      evidenceLocated: located,
      evidenceTotal: evidence.length,
    });
  }
  process.stderr.write(`${documents.length}/${PAPERS} ${id} · ${parsed.pages.length}p · ${docChunks.length} chunks\n`);
}

await writeCorpus(paths.corpus, chunks, documents);
await writeJsonl(paths.queries, queries);

const avgWords = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0) / chunks.length;
console.log(
  [
    `papers        ${documents.length} (${stats.parseFailures.length} skipped)`,
    `chunks        ${chunks.length} (avg ${avgWords.toFixed(0)} words)`,
    `questions     ${stats.questions}, ${stats.withEvidence} with text evidence`,
    `evidence      ${stats.located}/${stats.paragraphs} paragraphs found in LiteParse text (${((100 * stats.located) / stats.paragraphs).toFixed(1)}%)`,
    `queries kept  ${stats.kept} (avg ${(queries.reduce((n, q) => n + q.gold.length, 0) / queries.length).toFixed(2)} gold chunks)`,
    `wrote         ${paths.corpus}, ${paths.queries}`,
  ].join("\n"),
);
