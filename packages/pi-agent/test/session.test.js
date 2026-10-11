import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Agent,
  JsonlSession,
  forkSession,
  latestSession,
  listSessions,
  openSession,
  readTranscript,
  resolveSessionPath,
} from "../dist/index.js";
import { StubModel } from "./stub.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-session-"));

/** A session with two user messages and a tool result in the first turn. */
async function seedSession(dir) {
  const file = join(dir, "source.jsonl");
  const session = new JsonlSession({ file });
  await session.append({ role: "user", content: "read README.md and summarize it" });
  await session.append({
    role: "assistant",
    content: [{ type: "tool_call", id: "toolu_1", name: "read", arguments: { path: "README.md" }, rawArguments: "{}" }],
  });
  await session.append({ role: "tool", toolCallId: "toolu_1", toolName: "read", content: "1\t# pi\n2\ta harness" });
  await session.append({ role: "assistant", content: [{ type: "text", text: "It is a harness." }] });
  await session.append({ role: "user", content: "how many packages?" });
  await session.append({ role: "assistant", content: [{ type: "text", text: "Three." }] });
  return file;
}

test("a session round-trips through the JSONL file", async () => {
  const dir = await workspace();
  const file = await seedSession(dir);
  const messages = await readTranscript(file);
  assert.equal(messages.length, 6);
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].content, "1\t# pi\n2\ta harness");
});

test("reopening a session continues the seq numbering", async () => {
  const dir = await workspace();
  const file = await seedSession(dir);
  const { session, messages } = await openSession(file);
  assert.equal(messages.length, 6);

  await session.append({ role: "user", content: "and now?" });
  const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 7);
  assert.deepEqual(
    records.map((record) => record.seq),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

test("fork copies the path up to a user message and leaves the source alone", async () => {
  const dir = await workspace();
  const file = await seedSession(dir);
  const before = await readFile(file, "utf8");

  const fork = await forkSession({ source: file, at: 2, dir });
  assert.equal(fork.atUserMessage, 2);
  assert.equal(fork.copied, 4);
  assert.notEqual(fork.file, file);

  // The source is untouched.
  assert.equal(await readFile(file, "utf8"), before);

  // The fork stops just before the second user message and keeps the tool result.
  const forked = await readTranscript(fork.file);
  assert.deepEqual(
    forked.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(forked[2].content, "1\t# pi\n2\ta harness");

  // Seq numbers are renumbered from zero.
  const records = (await readFile(fork.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.seq),
    [0, 1, 2, 3],
  );
});

test("fork defaults to the last user message and rejects an out-of-range one", async () => {
  const dir = await workspace();
  const file = await seedSession(dir);

  const fork = await forkSession({ source: file, dir });
  assert.equal(fork.atUserMessage, 2);

  await assert.rejects(() => forkSession({ source: file, at: 3, dir }), /cannot fork at 3/);
});

test("a resumed agent sends the earlier tool result on its next call", async () => {
  const dir = await workspace();
  const file = await seedSession(dir);
  const { session, messages } = await openSession(file);

  const model = new StubModel([[{ text: "The first line is # pi." }]]);
  const agent = new Agent({ model, cwd: dir, session, messages });
  await agent.run("what was the first line of the file you read?");

  const sent = model.calls[0].messages;
  assert.equal(sent.length, 7);
  const toolResult = sent.find((message) => message.role === "tool");
  assert.equal(toolResult.content, "1\t# pi\n2\ta harness");
  assert.equal(sent.at(-1).content, "what was the first line of the file you read?");

  // The resumed run appends to the same file rather than starting a new one.
  const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 8);
  assert.deepEqual(records.at(-1).seq, 7);
});

test("sessions are listed newest first and resolve by id prefix", async () => {
  const dir = await workspace();
  const older = await seedSession(dir);
  await new Promise((done) => setTimeout(done, 5));
  const newer = join(dir, "20990101T000000Z-abcdef.jsonl");
  await writeFile(newer, `${JSON.stringify({ seq: 0, at: 1, message: { role: "user", content: "later" } })}\n`);

  const sessions = await listSessions(dir);
  assert.equal(sessions[0].file, newer);
  assert.equal(sessions[0].firstPrompt, "later");
  assert.equal(await latestSession(dir), newer);

  assert.equal(await resolveSessionPath(dir, "20990101T000000Z-abcdef"), newer);
  assert.equal(await resolveSessionPath(dir, "20990101"), newer);
  assert.equal(await resolveSessionPath(dir, older), older);
  await assert.rejects(() => resolveSessionPath(dir, "nope"), /no session nope/);
});
