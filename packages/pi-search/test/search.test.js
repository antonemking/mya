import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "pi-agent";
import { Bm25Index, SearchCorpus, chunkDocument, grep, loadCorpus, search, tokenize, writeCorpus } from "../dist/index.js";

const chunk = (id, text, extra = {}) => ({ id, doc: id.split("#")[0], title: "Paper", page: 1, text, ...extra });

test("tokenize drops stopwords and folds plurals", () => {
  assert.deepEqual(tokenize("The datasets of the Studies, BERT's 2 layers"), ["dataset", "study", "bert", "2", "layer"]);
});

test("bm25 ranks the chunk with the rarer shared term first", () => {
  const index = new Bm25Index([
    { id: "a", text: "we train a transformer on translation data" },
    { id: "b", text: "we train on translation data with pivoting through english" },
    { id: "c", text: "sentiment classification of tweets" },
  ]);
  const hits = index.search("pivoting translation");
  assert.equal(hits[0].id, "b");
  assert.equal(hits.length, 2);
  assert.equal(index.search("pivoting", { filter: (id) => id !== "b" }).length, 0);
});

test("grep matches literals by default and regexes on request", () => {
  const chunks = [chunk("d#0", "BLEU of 32.1 on Europarl (a.k.a. EP)"), chunk("d#1", "no scores here")];
  assert.deepEqual(grep(chunks, "a.k.a.").map((h) => h.id), ["d#0"]);
  assert.deepEqual(grep(chunks, "\\d+\\.\\d", { regex: true }).map((h) => h.id), ["d#0"]);
  assert.equal(grep(chunks, "bleu", { caseSensitive: true }).length, 0);
});

test("chunker packs blocks, tracks sections and pages, and skips images", () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkDocument(
    {
      id: "p",
      title: "A Paper",
      source: "p.pdf",
      pages: [
        { page: 1, markdown: `![](img.png)\n\n# A Paper\n\n## Introduction\n\n${long}\n\n${long}` },
        { page: 2, markdown: `## Method\n\n${long}` },
      ],
    },
    { targetWords: 50 },
  );
  assert.deepEqual(
    chunks.map((c) => [c.id, c.section, c.page]),
    [
      ["p#0", "Introduction", 1],
      ["p#1", "Method", 2],
    ],
  );
  assert.ok(!chunks[0].text.includes("img.png"));
});

test("the extension's tools search a corpus written to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-"));
  await writeCorpus(
    dir,
    [chunk("x#0", "zero-shot translation with a universal encoder", { section: "Method" }), chunk("x#1", "results on Multi-UN")],
    [{ id: "x", title: "Paper", source: "x.pdf", pages: 1, chunks: 2 }],
  );
  const corpus = await loadCorpus(dir);
  assert.ok(corpus instanceof SearchCorpus);
  const tools = Object.fromEntries(search(corpus).tools.map((t) => [t.name, t]));

  assert.match((await tools.search.execute({ query: "universal encoder" })).output, /^\[x#0\] Paper › Method \(p\.1\) score=/);
  assert.match((await tools.grep.execute({ pattern: "multi-un" })).output, /^\[x#1\]/);
  assert.match((await tools.read_chunk.execute({ ids: ["x#1", "x#9"] })).output, /results on Multi-UN[\s\S]*\[x#9\] no such chunk/);
  assert.match((await tools.list_documents.execute({})).output, /^x\tPaper\t1p\t2 chunks$/);
});

test("a bad regex is a tool error the model can read", async () => {
  const corpus = new SearchCorpus([chunk("x#0", "text")], []);
  const model = {
    provider: "stub",
    defaultModel: "stub",
    calls: 0,
    async *stream() {
      this.calls += 1;
      const content =
        this.calls === 1
          ? [{ type: "tool_call", id: "t1", name: "grep", arguments: { pattern: "(", regex: true }, rawArguments: "" }]
          : [{ type: "text", text: "done" }];
      yield { type: "message_done", message: { role: "assistant", content }, stopReason: "end_turn", usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } };
    },
  };
  const agent = new Agent({ model, tools: [], extensions: [search(corpus)] });
  const result = await agent.run("find it");
  const toolResult = result.messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /^grep failed: bad pattern/);
});
