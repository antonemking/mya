import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFakeAnthropic } from "./fakeAnthropic.js";
import { startFakeOpenAI } from "./fakeOpenAI.js";
import { isolatedEnv } from "./env.js";

const run = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const README = `# pi

A terminal harness that runs tools and appends the results.

## Tools

read, write, edit, bash.

## Events

agent_start through agent_end.
`;

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-provider-"));
  await writeFile(join(cwd, "README.md"), README);
  return cwd;
}

async function pi(args, { cwd, env = {} }) {
  return run(process.execPath, [cli, ...args], { cwd, env: isolatedEnv(cwd, env) });
}

test("the openai provider shows the same two turns", async () => {
  const cwd = await workspace();
  const server = await startFakeOpenAI();
  try {
    const { stdout } = await pi(["--provider", "openai", "-p", "read README.md and summarize it", "--no-session"], {
      cwd,
      env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: server.url, ANTHROPIC_API_KEY: "" },
    });

    // The banner names the provider, so the run is visibly not Anthropic.
    assert.match(stdout, /mya · openai\/gpt-4\.1/);
    assert.ok(!stdout.includes("anthropic"));

    const turnOne = stdout.indexOf("turn 1");
    const toolCall = stdout.indexOf('⏺ read {"path":"README.md"}');
    const turnTwo = stdout.indexOf("turn 2");
    assert.ok(turnOne !== -1 && toolCall > turnOne);
    assert.ok(turnTwo > toolCall);
    assert.match(stdout, /A terminal harness that runs tools/);
    assert.match(stdout, /end_turn · 2 turns/);

    // Two calls, and the second carried the tool result in the openai shape.
    assert.equal(server.requests.length, 2);
    const second = server.requests[1].messages;
    assert.equal(second.at(-1).role, "tool");
    assert.match(second.at(-1).content, /A terminal harness/);
    assert.equal(second[0].role, "system");
    assert.ok(server.requests[0].tools.some((t) => t.function.name === "read"));
  } finally {
    await server.close();
  }
});

test("both providers produce the same event list for the same prompt", async () => {
  const cwd = await workspace();
  const anthropic = await startFakeAnthropic();
  const openai = await startFakeOpenAI();
  try {
    const args = ["-p", "read README.md and summarize it", "--mode", "json", "--no-session"];
    const a = await pi(args, {
      cwd,
      env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: anthropic.url },
    });
    const o = await pi(["--provider", "openai", ...args], {
      cwd,
      env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: openai.url },
    });

    const shape = (stdout) =>
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type)
        .filter((type, i, all) => type !== "message_update" || all[i - 1] !== "message_update");

    assert.deepEqual(shape(a.stdout), shape(o.stdout));

    const providerOf = (stdout) => JSON.parse(stdout.trim().split("\n")[0]).provider;
    assert.equal(providerOf(a.stdout), "anthropic");
    assert.equal(providerOf(o.stdout), "openai");
  } finally {
    await anthropic.close();
    await openai.close();
  }
});

test("an unknown provider is refused by name", async () => {
  const cwd = await workspace();
  await assert.rejects(
    () => pi(["--provider", "gemini", "-p", "hi", "--no-session"], { cwd }),
    /unknown provider: gemini\. Known providers: anthropic, openai/,
  );
});

test("a missing key for the chosen provider is that provider's error", async () => {
  const cwd = await workspace();
  await assert.rejects(
    () => pi(["--provider", "openai", "-p", "hi", "--no-session"], { cwd, env: { OPENAI_API_KEY: "" } }),
    /OPENAI_API_KEY is not set/,
  );
});
