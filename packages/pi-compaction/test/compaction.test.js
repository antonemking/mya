import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, JsonlSession, openSession } from "pi-agent";
import { buildBody } from "pi-ai";
import { COMPACTION_KIND, compaction, estimateTokens, isCompactionRecord } from "../dist/index.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-compact-"));

/** Records every request so we can inspect the summary call. */
class RecordingModel {
  constructor(script) {
    this.provider = "stub";
    this.defaultModel = "stub-1";
    this.script = [...script];
    this.calls = [];
  }

  async *stream(request) {
    this.calls.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("model ran out of script");
    const content = [];
    for (const block of step) {
      if (block.text !== undefined) {
        yield { type: "text_delta", text: block.text };
        content.push({ type: "text", text: block.text });
      } else {
        const raw = JSON.stringify(block.arguments ?? {});
        content.push({ type: "tool_call", id: block.id, name: block.name, arguments: block.arguments ?? {}, rawArguments: raw });
      }
    }
    yield {
      type: "message_done",
      message: { role: "assistant", content },
      stopReason: content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
    };
  }
}

const bulk = (label, size) => `${label} ${"x".repeat(size)}`;

/** A transcript already over any small threshold. */
async function seed(file) {
  const session = new JsonlSession({ file });
  await session.append({ role: "user", content: "read README.md and summarize it" });
  await session.append({
    role: "assistant",
    content: [{ type: "tool_call", id: "toolu_1", name: "read", arguments: { path: "README.md" }, rawArguments: "{}" }],
  });
  await session.append({ role: "tool", toolCallId: "toolu_1", toolName: "read", content: bulk("1\t# pi", 20_000) });
  await session.append({ role: "assistant", content: [{ type: "text", text: "It is a harness." }] });
  await session.append({ role: "user", content: "how many packages?" });
  await session.append({ role: "assistant", content: [{ type: "text", text: "Three." }] });
}

test("under the threshold the context is passed through untouched", async () => {
  const dir = await workspace();
  const file = join(dir, "s.jsonl");
  await seed(file);
  const { session, messages } = await openSession(file);

  const model = new RecordingModel([[{ text: "fine" }]]);
  const agent = new Agent({
    model,
    cwd: dir,
    session,
    messages,
    extensions: [compaction({ contextWindow: 1_000_000, log: () => {} })],
  });
  await agent.run("still small?");

  assert.equal(model.calls.length, 1, "no summary call");
  assert.equal(model.calls[0].messages.length, 7);
  const records = await readRecords(file);
  assert.ok(!records.some((r) => isCompactionRecord(r.message)));
});

test("over the threshold it summarizes, keeps a tail, and writes the summary to the session", async () => {
  const dir = await workspace();
  const file = join(dir, "s.jsonl");
  await seed(file);
  const { session, messages } = await openSession(file);
  const notices = [];

  const model = new RecordingModel([
    [{ text: "The user asked about README.md; read returned a 4000 character file; three packages." }],
    [{ text: "Still three." }],
  ]);
  const agent = new Agent({
    model,
    cwd: dir,
    session,
    messages,
    extensions: [compaction({ contextWindow: 2000, threshold: 0.8, keepTail: 2, log: (t) => notices.push(t) })],
  });
  await agent.run("say it again");

  // Two calls: the summary, then the turn.
  assert.equal(model.calls.length, 2);
  const [summaryCall, turnCall] = model.calls;

  // The summary call is a single user message and writes no cache.
  assert.equal(summaryCall.cache, false);
  assert.equal(summaryCall.messages.length, 1);
  assert.equal(summaryCall.messages[0].role, "user");
  assert.match(summaryCall.messages[0].content, /TOOL RESULT \(read\)/);
  assert.match(summaryCall.messages[0].content, /xxxxxxx/, "the default policy still sends the tool body");
  assert.equal(summaryCall.tools, undefined);

  // The turn that followed starts with the summary and keeps a short tail.
  assert.match(turnCall.messages[0].content, /has been compacted out of the transcript/);
  assert.match(turnCall.messages[0].content, /three packages/);
  assert.ok(turnCall.messages.length < 7, "the tail is shorter than the transcript");
  assert.equal(turnCall.messages.at(-1).content, "say it again");
  // No orphaned tool result: the tail starts at a user message.
  assert.equal(turnCall.messages[1].role, "user");

  // The summary is in the session as its own record.
  const records = await readRecords(file);
  const record = records.find((r) => isCompactionRecord(r.message));
  assert.ok(record, "a compaction record was written");
  assert.equal(record.message.kind, COMPACTION_KIND);
  // keepTail was 2, but the tail snapped forward to the newest user message.
  assert.equal(record.message.payload.summarized, 6);
  assert.equal(record.message.payload.covers, 6);
  assert.match(record.message.payload.summary, /three packages/);
  assert.deepEqual(
    records.map((r) => r.seq),
    records.map((_, i) => i),
  );

  assert.match(notices[0], /compacted 6 messages/);
  assert.match(notices[0], /cache read 0, write 0/);
});

test("a resumed session reuses the summary instead of paying for it again", async () => {
  const dir = await workspace();
  const file = join(dir, "s.jsonl");
  await seed(file);

  const first = await openSession(file);
  const model = new RecordingModel([[{ text: "a summary of the old turns" }], [{ text: "ok" }]]);
  await new Agent({
    model,
    cwd: dir,
    session: first.session,
    messages: first.messages,
    extensions: [compaction({ contextWindow: 2000, threshold: 0.8, keepTail: 2, log: () => {} })],
  }).run("first");
  assert.equal(model.calls.length, 2);

  // Resume: the compaction record is in the transcript now.
  const second = await openSession(file);
  const model2 = new RecordingModel([[{ text: "ok again" }]]);
  await new Agent({
    model: model2,
    cwd: dir,
    session: second.session,
    messages: second.messages,
    extensions: [compaction({ contextWindow: 2000, threshold: 0.8, keepTail: 2, log: () => {} })],
  }).run("second");

  // One call: no new summary, and the old bulk tool result is gone.
  assert.equal(model2.calls.length, 1);
  const sent = model2.calls[0].messages;
  assert.match(sent[0].content, /a summary of the old turns/);
  assert.ok(!JSON.stringify(sent).includes("xxxxxxxxxx"), "the summarized bulk is not resent");
  assert.equal(sent.at(-1).content, "second");
});

test("cache:false removes the breakpoint from the request body", () => {
  const messages = [{ role: "user", content: "summarize this" }];
  const cached = buildBody({ model: "m", messages }, "m", 1024);
  const uncached = buildBody({ model: "m", messages, cache: false }, "m", 1024);

  assert.deepEqual(cached.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(uncached.messages.at(-1).content.at(-1).cache_control, undefined);
});

test("the estimator counts the whole message, not just its text", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const large = estimateTokens([{ role: "user", content: "hi".repeat(1000) }]);
  assert.ok(small < 20);
  assert.ok(large > 400);
});

async function readRecords(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
