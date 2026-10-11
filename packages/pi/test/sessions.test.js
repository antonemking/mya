import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFakeAnthropic } from "./fakeAnthropic.js";
import { isolatedEnv } from "./env.js";

const run = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const README = `# pi

A terminal harness that runs tools and appends the results.

## Tools

read, write, edit, bash.
`;

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sessions-"));
  await writeFile(join(cwd, "README.md"), README);
  return cwd;
}

/** Answers with whatever the last user message asked, so branches are visible. */
function scriptedServer() {
  return startFakeAnthropic({
    reply: (request) => {
      const text = JSON.stringify(request.messages);
      const lastUser = [...request.messages].reverse().find((m) => m.role === "user" && m.content[0]?.type === "text");
      const ask = lastUser?.content[0]?.text ?? "";

      if (!text.includes("tool_result")) {
        return {
          stopReason: "tool_use",
          blocks: [{ type: "tool_use", id: `toolu_${request.messages.length}`, name: "read", input: { path: "README.md" } }],
        };
      }
      // Quote the tool result so the answer proves what the model could see.
      const firstLine = /1\\t(# pi)/.exec(text)?.[1] ?? "nothing";
      return { stopReason: "end_turn", blocks: [{ type: "text", text: `[${ask}] the file starts with ${firstLine}` }] };
    },
  });
}

async function pi(args, cwd, baseUrl) {
  return run(process.execPath, [cli, ...args], {
    cwd,
    env: isolatedEnv(cwd, { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseUrl }),
  });
}

const sessionFiles = async (cwd) =>
  (await readdir(join(cwd, ".mya", "sessions")))
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".events.jsonl"))
    .sort();

test("continue resumes the last session and sees the earlier tool result", async () => {
  const cwd = await workspace();
  const server = await scriptedServer();
  try {
    await pi(["-p", "read README.md and summarize it"], cwd, server.url);
    const [first] = await sessionFiles(cwd);

    const { stdout, stderr } = await pi(["-c", "-p", "how many packages?"], cwd, server.url);
    assert.match(stderr, /resumed .*\.jsonl: 4 messages/);
    assert.match(stdout, /how many packages\?/);

    // Same file, appended, not a new one.
    assert.deepEqual(await sessionFiles(cwd), [first]);
    const records = (await readFile(join(cwd, ".mya", "sessions", first), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.message.role),
      ["user", "assistant", "tool", "assistant", "user", "assistant"],
    );

    // The resumed model call carried the tool result from the first run.
    const resumedCall = server.requests.at(-1).messages;
    assert.ok(resumedCall.some((m) => m.content.some?.((b) => b.type === "tool_result")));
  } finally {
    await server.close();
  }
});

test("resume by id prefix picks that session out of several", async () => {
  const cwd = await workspace();
  const server = await scriptedServer();
  try {
    await pi(["-p", "first session"], cwd, server.url);
    const [target] = await sessionFiles(cwd);
    const id = target.replace(".jsonl", "");
    await new Promise((done) => setTimeout(done, 5));
    await pi(["-p", "second session"], cwd, server.url);

    // A prefix that reaches into the random suffix is unique.
    const { stderr } = await pi(["-r", id.slice(0, 19), "-p", "back to the first"], cwd, server.url);
    assert.match(stderr, new RegExp(`resumed .*${id}\\.jsonl`));

    // A prefix shared by both sessions is refused rather than guessed.
    await assert.rejects(
      () => pi(["-r", id.slice(0, 12), "-p", "which one?"], cwd, server.url),
      /is ambiguous \(2 matches\)/,
    );
  } finally {
    await server.close();
  }
});

test("fork copies up to an earlier user message and leaves the source unchanged", async () => {
  const cwd = await workspace();
  const server = await scriptedServer();
  try {
    await pi(["-p", "read README.md and summarize it"], cwd, server.url);
    await pi(["-c", "-p", "how many packages?"], cwd, server.url);
    const [sourceName] = await sessionFiles(cwd);
    const sourceFile = join(cwd, ".mya", "sessions", sourceName);
    const sourceBefore = await readFile(sourceFile, "utf8");

    const { stdout, stderr } = await pi(
      ["--fork", sourceName.replace(".jsonl", ""), "--at", "2", "-p", "instead, name the tools"],
      cwd,
      server.url,
    );
    assert.match(stderr, /forked .* before user message 2: 4 messages copied/);

    // The source file is byte-identical.
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);

    // The fork is a new file holding the copied path plus the new branch.
    const files = await sessionFiles(cwd);
    assert.equal(files.length, 2);
    const forkName = files.find((name) => name !== sourceName);
    const forked = (await readFile(join(cwd, ".mya", "sessions", forkName), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      forked.map((r) => r.message.role),
      ["user", "assistant", "tool", "assistant", "user", "assistant"],
    );
    assert.equal(forked[4].message.content, "instead, name the tools");
    assert.deepEqual(
      forked.map((r) => r.seq),
      [0, 1, 2, 3, 4, 5],
    );

    // The fork's first turn answered from the tool result it inherited.
    assert.match(stdout, /instead, name the tools\] the file starts with # pi/);
    const forkCall = server.requests.at(-1).messages;
    assert.ok(forkCall.some((m) => m.content.some?.((b) => b.type === "tool_result")));
    assert.equal(forkCall.at(-1).content[0].text, "instead, name the tools");
    // One model call: the inherited tool result meant no second read.
    assert.equal(forkCall.filter((m) => m.role === "user").length, 3);
  } finally {
    await server.close();
  }
});

test("replay prints the recorded run without calling the model", async () => {
  const cwd = await workspace();
  const server = await scriptedServer();
  let id = "";
  let calls = 0;
  try {
    await pi(["-p", "read README.md and summarize it"], cwd, server.url);
    calls = server.requests.length;
    const [file] = await sessionFiles(cwd);
    id = file.replace(/\.jsonl$/, "");
  } finally {
    await server.close();
  }

  const { stdout } = await pi(["replay", id, "--json"], cwd, "http://127.0.0.1:9");
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const request = events.find((event) => event.type === "model_request");
  assert.ok(request);
  assert.match(request.body, /README\.md/);
  assert.equal(request.body.includes("test-key"), false);
  assert.ok(events.some((event) => event.type === "model_response" && event.status === 200));
  assert.equal(server.requests.length, calls);
});

test("--sessions lists what is on disk", async () => {
  const cwd = await workspace();
  const server = await scriptedServer();
  try {
    await pi(["-p", "read README.md and summarize it"], cwd, server.url);
    const { stdout } = await pi(["--sessions"], cwd, server.url);
    assert.match(stdout, /\d+ msgs {2}read README\.md and summarize it/);
  } finally {
    await server.close();
  }
});
