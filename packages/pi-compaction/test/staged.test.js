import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, JsonlSession, openSession } from "pi-agent";
import {
  compaction,
  isCompactionRecord,
  lookupContextWindow,
  resolveContextWindow,
} from "../dist/index.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-staged-"));

class RecordingModel {
  constructor(script, provider = "stub", model = "stub-1") {
    this.provider = provider;
    this.defaultModel = model;
    this.script = [...script];
    this.calls = [];
  }

  async *stream(request) {
    this.calls.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("model ran out of script");
    const content = step.map((text) => ({ type: "text", text }));
    yield {
      type: "message_done",
      message: { role: "assistant", content },
      stopReason: "end_turn",
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
    };
  }
}

const text = (value) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const call = (id, name) => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name, arguments: {}, rawArguments: "{}" }],
});
const result = (id, name, content) => ({ role: "tool", toolCallId: id, toolName: name, content });

async function seed(file) {
  const session = new JsonlSession({ file });
  await session.append({ role: "user", content: "fix the parser" });
  await session.append(call("toolu_1", "read"));
  await session.append(result("toolu_1", "read", `OLD ${"x".repeat(40_000)}`));
  await session.append(text("parser is large"));
  await session.append({ role: "user", content: "keep going" });
  await session.append(text("still looking"));
  await session.append({ role: "user", content: "run the tests" });
  await session.append(call("toolu_2", "bash"));
  await session.append(result("toolu_2", "bash", "ok 12 passed"));
  await session.append(text("tests passed"));
}

test("staged elision stubs a stale tool body and does not call the summarizer", async () => {
  const dir = await workspace();
  const file = join(dir, "s.jsonl");
  await seed(file);
  const { session, messages } = await openSession(file);
  const notices = [];
  const model = new RecordingModel([["done"]]);
  await new Agent({
    model,
    cwd: dir,
    tools: [],
    session,
    messages,
    extensions: [compaction({ staged: true, contextWindow: 16_000, log: (line) => notices.push(line) })],
  }).run("ship it");

  assert.equal(model.calls.length, 1, "elision was enough, so no summary call");
  const sent = JSON.stringify(model.calls[0].messages);
  assert.match(sent, /tool output elided: 1 lines \/ 40004 chars/);
  assert.match(sent, /Re-read or re-run to get it again/);
  assert.equal(sent.includes("recall_event"), false);
  assert.equal(sent.includes("xxxxx"), false);
  assert.match(sent, /ok 12 passed/, "the recent tool result stays");
  assert.match(sent, /fix the parser/);
  assert.match(notices[0], /summary skipped/);

  const raw = await readFile(file, "utf8");
  assert.match(raw, /xxxxx/, "the session file still has the original tool output");
  assert.equal(
    raw
      .trim()
      .split("\n")
      .some((line) => isCompactionRecord(JSON.parse(line).message)),
    false,
  );
});

test("when elision is not enough the summarizer sees stubs, not the tool body", async () => {
  const dir = await workspace();
  const file = join(dir, "s.jsonl");
  const session = new JsonlSession({ file });
  await session.append({ role: "user", content: "fix the parser" });
  await session.append(call("toolu_1", "read"));
  await session.append(result("toolu_1", "read", `OLD ${"x".repeat(20_000)}`));
  await session.append(text("parser is large"));
  await session.append({ role: "user", content: `notes ${"y".repeat(30_000)}` });
  await session.append(text("noted"));
  await session.append({ role: "user", content: "recent question" });
  await session.append(text("recent answer"));
  const opened = await openSession(file);

  const model = new RecordingModel([["kept the file path parser.ts"], ["shipped"]]);
  await new Agent({
    model,
    cwd: dir,
    tools: [],
    session: opened.session,
    messages: opened.messages,
    extensions: [compaction({ staged: true, contextWindow: 8_000, log: () => {} })],
  }).run("ship it");

  assert.equal(model.calls.length, 2);
  const [summaryCall, turnCall] = model.calls;
  assert.equal(summaryCall.cache, false);
  assert.match(summaryCall.messages[0].content, /tool output elided:/);
  assert.equal(summaryCall.messages[0].content.includes("xxxxx"), false);
  assert.match(summaryCall.messages[0].content, /yyyyy/);
  assert.equal(JSON.stringify(turnCall.messages).includes("xxxxx"), false);
  assert.equal(JSON.stringify(turnCall.messages).includes("recall_event"), false);
  assert.equal(turnCall.messages[0].content, "fix the parser");
  assert.match(turnCall.messages[1].content, /has been compacted out of the transcript/);

  const records = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const record = records.find((row) => isCompactionRecord(row.message));
  assert.ok(record);
  assert.ok(record.message.payload.elided >= 1);
  assert.match(records.map((row) => row.message).find((message) => message.role === "tool").content, /xxxxx/);
});

test("the default policy ignores the model table and still summarizes at 200k", async () => {
  const model = new RecordingModel([["summary"], ["ok"]], "openai", "gpt-5.5");
  const messages = [
    { role: "user", content: "one" },
    text("two"),
    { role: "user", content: "three" },
  ];
  await new Agent({
    model,
    tools: [],
    messages,
    extensions: [compaction({ estimateTokens: () => 200_000, keepTail: 2, log: () => {} })],
  }).run("four");
  assert.equal(model.calls.length, 2, "200k × 0.8 is 160k, and 200k estimated tokens still trip it");
});

test("staged sizes the window to the model, so gpt-5.5 does not summarize a 200k estimate", async () => {
  const notices = [];
  const model = new RecordingModel([["ok"]], "openai", "gpt-5.5");
  const messages = [
    { role: "user", content: "one" },
    text("two"),
    { role: "user", content: "three" },
  ];
  await new Agent({
    model,
    tools: [],
    messages,
    extensions: [
      compaction({
        staged: true,
        estimateTokens: () => 200_000,
        keepTail: 2,
        log: (line) => notices.push(line),
      }),
    ],
  }).run("four");
  assert.equal(model.calls.length, 1);
  assert.match(notices[0], /context window 1050000 for openai\/gpt-5\.5/);
});

test("an unknown model falls back to 200000", async () => {
  const notices = [];
  const model = new RecordingModel([["summary"], ["ok"]], "openai", "llama3");
  const messages = [
    { role: "user", content: "one" },
    text("two"),
    { role: "user", content: "three" },
  ];
  await new Agent({
    model,
    tools: [],
    messages,
    extensions: [
      compaction({
        modelWindow: true,
        estimateTokens: () => 200_000,
        keepTail: 2,
        log: (line) => notices.push(line),
      }),
    ],
  }).run("four");
  assert.equal(model.calls.length, 2);
  assert.match(notices[0], /no context window for openai\/llama3; using 200000/);
});

test("after one turn the estimate scales by the provider's prompt tokens", async () => {
  const appended = [];
  const messages = [
    { role: "user", content: "one" },
    text("two"),
    { role: "user", content: "three" },
  ];
  const model = new RecordingModel([["summary"]]);
  const ext = compaction({ modelWindow: true, contextWindow: 10_000, keepTail: 2, log: () => {} });
  const input = () => ({
    messages: [...messages, ...appended],
    turn: 1,
    cwd: "/tmp",
    model: "gpt-4.1",
    system: "sys",
    tools: [],
    modelClient: model,
    session: { id: "s", async append() {} },
    append: async (message) => {
      appended.push(message);
    },
  });

  await ext.transformContext(input());
  assert.equal(appended.length, 0);

  ext.onEvent({
    type: "turn_end",
    turn: 1,
    message: text("two"),
    stopReason: "end_turn",
    usage: { inputTokens: 7_000, cachedInputTokens: 1_500, cacheWriteTokens: 500, outputTokens: 1 },
    toolCalls: 0,
    at: 1,
  });
  await ext.transformContext(input());
  assert.equal(appended.length, 1, "9000 reported prompt tokens is over 0.8 × 10000");
  assert.equal(model.calls.length, 1);
});

test("window lookup is provider plus model, with an env override and a 200k fallback", () => {
  assert.equal(lookupContextWindow("anthropic", "claude-sonnet-4-5")?.window, 200_000);
  assert.equal(lookupContextWindow("anthropic", "claude-sonnet-4-5-20250929")?.window, 200_000);
  assert.equal(lookupContextWindow("openai", "gpt-4.1")?.window, 1_047_576);
  assert.equal(lookupContextWindow("openai", "gpt-5.5")?.window, 1_050_000);
  assert.equal(lookupContextWindow("openai", "gpt-5.5-2026-04-23")?.window, 1_050_000);
  assert.equal(lookupContextWindow("openai-codex", "gpt-5.5")?.window, 272_000);
  assert.equal(lookupContextWindow("openai", "gpt-5.5-pro"), undefined);
  assert.equal(lookupContextWindow("openai", "gpt-5.5-pro-2026-04-23"), undefined);
  assert.equal(lookupContextWindow("openai", "llama3"), undefined);

  const overridden = resolveContextWindow("openai", "gpt-5.5", { modelWindow: true }, { PI_CONTEXT_WINDOW: "32_000" });
  assert.equal(overridden.source, "env");
  assert.equal(overridden.window, 32_000);

  const option = resolveContextWindow(
    "openai",
    "gpt-5.5",
    { modelWindow: true, contextWindow: 12_000 },
    { PI_CONTEXT_WINDOW: "32_000" },
  );
  assert.equal(option.source, "option");
  assert.equal(option.window, 12_000);

  const fallback = resolveContextWindow("openai", "llama3", { modelWindow: true }, {});
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.window, 200_000);

  const unchanged = resolveContextWindow("openai", "gpt-5.5", { modelWindow: false }, {});
  assert.equal(unchanged.source, "default");
  assert.equal(unchanged.window, 200_000);

  const invalid = resolveContextWindow("openai", "gpt-5.5", { modelWindow: true }, { PI_CONTEXT_WINDOW: "nope" });
  assert.equal(invalid.source, "table");
  assert.equal(invalid.window, 1_050_000);
});
