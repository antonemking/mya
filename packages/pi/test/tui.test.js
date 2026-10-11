import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "pi-agent";
import { startTui } from "../dist/index.js";
import { StubModel } from "../../pi-agent/test/stub.js";
import { startFakeAnthropic } from "./fakeAnthropic.js";
import { isolatedEnv } from "./env.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const README = `# pi

A terminal harness that runs tools and appends the results.

## Tools

read, write, edit, bash.
`;

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-tui-"));
  await writeFile(join(cwd, "README.md"), README);
  return cwd;
}

/** Drives the TUI over a pipe: type lines, collect what it draws. */
function runTui(cwd, baseUrl, lines) {
  return runTuiScript(cwd, baseUrl, lines.map((line) => ({ line })));
}

/**
 * `after` waits until stdout matches before the line is written, so a line
 * can land while a tool is still running.
 */
function runTuiScript(cwd, baseUrl, steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--tui", "--no-session"], {
      cwd,
      env: isolatedEnv(cwd, { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseUrl }),
    });
    let stdout = "";
    let stderr = "";
    let cursor = 0;
    const pump = () => {
      while (cursor < steps.length) {
        const step = steps[cursor];
        if (step.after && !step.after.test(stdout)) return;
        cursor += 1;
        child.stdin.write(`${step.line}\n`);
      }
      child.stdin.end();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pump();
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    pump();
  });
}

test("the TUI shows the same two turns as print mode", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    const { stdout, code } = await runTui(cwd, server.url, ["read README.md and summarize it"]);

    assert.equal(code, 0);
    // Banner, then the prompt.
    assert.match(stdout, /mya · anthropic\//);
    assert.match(stdout, /\/help for commands/);
    assert.match(stdout, /› /);

    // Turn one is the tool call, turn two is the answer.
    const turnOne = stdout.indexOf("turn 1");
    const toolCall = stdout.indexOf('⏺ read {"path":"README.md"}');
    const turnTwo = stdout.indexOf("turn 2");
    const answer = stdout.indexOf("A terminal harness that runs tools");
    assert.ok(turnOne !== -1 && toolCall > turnOne, "turn 1 shows the tool call");
    assert.ok(turnTwo > toolCall, "turn 2 comes after the tool call");
    assert.ok(answer > turnTwo, "the answer lands in turn 2");
    assert.match(stdout, /end_turn · 2 turns/);

    // Two model calls, and the second one carried the tool result.
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1].messages.at(-1).content[0].type, "tool_result");
  } finally {
    await server.close();
  }
});

test("the TUI streams text as message_update events arrive", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    // The renderer writes deltas as they land, so the answer is not one write.
    const { stdout } = await runTui(cwd, server.url, ["read README.md and summarize it"]);
    const answerStart = stdout.indexOf("pi: A terminal harness");
    assert.ok(answerStart !== -1);
    assert.match(stdout.slice(answerStart), /The file is \d+ lines long\./);
  } finally {
    await server.close();
  }
});

test("the transcript carries across prompts in one session", async () => {
  const cwd = await workspace();
  let call = 0;
  const server = await startFakeAnthropic({
    reply: () => {
      call += 1;
      if (call === 1) {
        return {
          stopReason: "tool_use",
          blocks: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } }],
        };
      }
      if (call === 2) return { stopReason: "end_turn", blocks: [{ type: "text", text: "It is a harness." }] };
      return { stopReason: "end_turn", blocks: [{ type: "text", text: "Yes, four tools." }] };
    },
  });

  try {
    const { stdout } = await runTui(cwd, server.url, ["read README.md and summarize it", "how many tools?"]);
    assert.match(stdout, /It is a harness\./);
    assert.match(stdout, /Yes, four tools\./);
    assert.match(stdout, /turn 3/);

    // The third call still sees the first prompt and the tool result.
    const third = server.requests[2].messages;
    assert.equal(third[0].content[0].text, "read README.md and summarize it");
    assert.ok(third.some((m) => m.content.some?.((b) => b.type === "tool_result")));
    assert.equal(third.at(-1).content[0].text, "how many tools?");
  } finally {
    await server.close();
  }
});

test("Enter during a run steers and the remaining tools do not run", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic({
    reply: (request) => {
      const steered = request.messages.some(
        (message) => message.role === "user" && message.content?.[0]?.text === "stop, just answer",
      );
      if (steered) return { stopReason: "end_turn", blocks: [{ type: "text", text: "Steered." }] };
      return {
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "toolu_slow", name: "bash", input: { command: "sleep 1" } },
          { type: "tool_use", id: "toolu_later", name: "bash", input: { command: "echo SHOULD_NOT_RUN" } },
        ],
      };
    },
  });

  try {
    const { stdout, code } = await runTuiScript(cwd, server.url, [
      { line: "run both" },
      { after: /⏺ bash/, line: "stop, just answer" },
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Steered\./);
    assert.match(stdout, /not run: a steering message arrived/);
    assert.doesNotMatch(stdout, /✓.*SHOULD_NOT_RUN/);
    const second = server.requests[1];
    assert.ok(second, "the steer starts another model call");
    const texts = second.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.map((block) => block.text).filter(Boolean) : [],
    );
    assert.ok(texts.includes("stop, just answer"));
  } finally {
    await server.close();
  }
});

test("Alt+Enter during a run is a follow-up and Enter is a steer", async () => {
  const cwd = await workspace();
  const batch = () => [
    { id: "a", name: "slow", arguments: {} },
    { id: "b", name: "later", arguments: {} },
  ];
  const tools = () => {
    const state = { later: false };
    return {
      state,
      tools: [
        {
          name: "slow",
          description: "Takes a moment.",
          parameters: { type: "object", properties: {} },
          execute: () => new Promise((resolve) => setTimeout(() => resolve({ output: "slow done" }), 80)),
        },
        {
          name: "later",
          description: "Runs unless steered.",
          parameters: { type: "object", properties: {} },
          execute: () => {
            state.later = true;
            return { output: "later ran" };
          },
        },
      ],
    };
  };

  const followTools = tools();
  const follow = await driveTui(
    cwd,
    followTools.tools,
    [batch(), [{ text: "first answer" }], [{ text: "second answer" }]],
    async (input, output) => {
      input.write("do both\r");
      await output.waitFor(/⏺ slow/);
      input.write("next task\x1b\r");
      await output.waitFor(/second answer/);
      input.write("/exit\r");
    },
  );
  assert.equal(followTools.state.later, true);
  assert.match(follow.stdout, /first answer/);
  assert.match(follow.stdout, /second answer/);
  assert.equal(follow.messages.filter((message) => message.role === "user").at(-1).content, "next task");
  assert.doesNotMatch(follow.stdout, /not run/);

  const steerTools = tools();
  const steer = await driveTui(
    cwd,
    steerTools.tools,
    [batch(), [{ text: "steered answer" }]],
    async (input, output) => {
      input.write("do both\r");
      await output.waitFor(/⏺ slow/);
      input.write("stop now\r");
      await output.waitFor(/steered answer/);
      input.write("/exit\r");
    },
  );
  assert.equal(steerTools.state.later, false);
  assert.match(steer.stdout, /not run/);
  assert.equal(steer.messages.filter((message) => message.role === "user").at(-1).content, "stop now");
});

function ttyPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => input;
  output.columns = 80;
  return { input, output };
}

function driveTui(cwd, tools, script, drive) {
  const agent = new Agent({
    model: new StubModel(script),
    cwd,
    tools: [],
    extensions: [{ name: "ext", tools }],
  });
  const { input, output } = ttyPair();
  let stdout = "";
  let waiting;
  output.on("data", (chunk) => {
    stdout += chunk;
    if (waiting?.pattern.test(stdout)) {
      const resolve = waiting.resolve;
      waiting = undefined;
      resolve();
    }
  });
  const done = startTui({ agent, input, output, color: false });
  const driven = drive(input, {
    waitFor(pattern) {
      if (pattern.test(stdout)) return Promise.resolve();
      return new Promise((resolve) => {
        waiting = { pattern, resolve };
      });
    },
  }).then(() => input.end());
  return Promise.all([done, driven]).then(() => ({ stdout, messages: agent.messages }));
}

test("slash commands are handled by the view, not the model", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    const { stdout } = await runTui(cwd, server.url, ["/tools", "/help", "/exit"]);
    assert.match(stdout, /read, write, edit, bash, check/);
    assert.match(stdout, /\/session {3}show the session file/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
