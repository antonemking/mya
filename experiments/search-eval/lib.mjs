import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..", "..");
const data = join(here, "data");

export const paths = {
  data,
  qasper: join(data, "qasper-dev-v0.3.json"),
  pdfs: join(data, "pdfs"),
  corpus: join(data, "corpus"),
  queries: join(data, "queries.jsonl"),
  results: join(data, "results"),
  runs: join(data, "runs"),
  cache: join(data, "cache"),
  report: join(data, "report.md"),
};

/** The dev scripts read the repo's .env; the packages read only the environment. */
export function loadEnv() {
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch {
    // No .env. The environment decides.
  }
}

/** `--key value`, `--flag`, and bare words. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export async function readJsonl(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export async function writeJsonl(file, records) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

export async function appendJsonl(file, record) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

/** One JSON file per key. Reruns replay from here instead of paying again. */
export class DirCache {
  constructor(dir) {
    this.dir = dir;
  }
  #file(key) {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }
  async get(key) {
    const text = await readFile(this.#file(key), "utf8").catch(() => undefined);
    return text === undefined ? undefined : JSON.parse(text);
  }
  async set(key, value) {
    const file = this.#file(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), "utf8");
  }
}

export async function mapPool(items, size, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Same precedence as the CLI: flag, environment, `mya config`, then anthropic. */
export async function resolveProvider(flags) {
  const settings = JSON.parse(
    await readFile(join(process.env.MYA_HOME || join(homedir(), ".mya"), "settings.json"), "utf8").catch(() => "{}"),
  );
  const provider = flags.provider || process.env.MYA_PROVIDER || settings.provider || "anthropic";
  const model = flags.model || process.env.MYA_MODEL || (settings.provider === provider ? settings.model : undefined);
  return { provider, model };
}

export const EMBEDDING_MODEL = process.env.SEARCH_EVAL_EMBEDDING_MODEL || "text-embedding-3-small";

/** OpenAI embeddings, cached per text. Returns Float32Arrays and the tokens actually billed. */
export async function embed(texts, { cache, model = EMBEDDING_MODEL, batch = 96 } = {}) {
  const baseUrl = process.env.OPENAI_EMBEDDINGS_BASE_URL || "https://api.openai.com/v1";
  const key = process.env.OPENAI_API_KEY;
  const out = new Array(texts.length);
  const missing = [];
  for (const [i, text] of texts.entries()) {
    const hit = await cache?.get(sha({ model, text }));
    if (hit) out[i] = decode(hit.vector);
    else missing.push(i);
  }
  let tokens = 0;
  for (let start = 0; start < missing.length; start += batch) {
    if (!key) throw new Error("OPENAI_API_KEY is not set; the semantic arm needs it for embeddings");
    const indexes = missing.slice(start, start + batch);
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: indexes.map((i) => texts[i]) }),
    });
    if (!response.ok) throw new Error(`embeddings ${response.status}: ${await response.text()}`);
    const body = await response.json();
    tokens += body.usage?.total_tokens ?? 0;
    for (const item of body.data) {
      const i = indexes[item.index];
      out[i] = Float32Array.from(item.embedding);
      await cache?.set(sha({ model, text: texts[i] }), { vector: encode(out[i]) });
    }
  }
  return { vectors: out, tokens };
}

const encode = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
const decode = (text) => {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** Binary relevance: any gold chunk counts. */
export function scoreRanking(ranked, gold) {
  const goldSet = new Set(gold);
  const first = ranked.findIndex((id) => goldSet.has(id));
  const hitAt = (k) => (first !== -1 && first < k ? 1 : 0);
  const top10 = ranked.slice(0, 10);
  let dcg = 0;
  for (const [i, id] of top10.entries()) if (goldSet.has(id)) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(goldSet.size, 10); i += 1) idcg += 1 / Math.log2(i + 2);
  return {
    hit1: hitAt(1),
    hit5: hitAt(5),
    hit10: hitAt(10),
    hit30: hitAt(30),
    recall10: top10.filter((id) => goldSet.has(id)).length / goldSet.size,
    mrr10: first !== -1 && first < 10 ? 1 / (first + 1) : 0,
    ndcg10: idcg === 0 ? 0 : dcg / idcg,
  };
}
