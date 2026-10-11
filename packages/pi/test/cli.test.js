import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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

## Events

agent_start through agent_end.
`;

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cli-"));
  await writeFile(join(cwd, "README.md"), README);
  return cwd;
}

async function pi(args, { cwd, baseUrl, extra = {} }) {
  return run(process.execPath, [cli, ...args], {
    cwd,
    env: isolatedEnv(cwd, { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseUrl, ...extra }),
  });
}

test("print mode shows a tool call turn and then the answer", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    const { stdout } = await pi(["-p", "read README.md and summarize it", "--no-session"], {
      cwd,
      baseUrl: server.url,
    });

    assert.match(stdout, /turn 1/);
    assert.match(stdout, /⏺ read \{"path":"README.md"\}/);
    assert.match(stdout, /turn 2/);
    // The answer depends on the file that was read.
    assert.match(stdout, /A terminal harness that runs tools/);
    assert.match(stdout, /It covers Tools, Events/);
    assert.match(stdout, /end_turn · 2 turns/);

    // The tool result reached the second model call.
    assert.equal(server.requests.length, 2);
    const toolResult = server.requests[1].messages.at(-1).content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.match(toolResult.content, /A terminal harness/);
  } finally {
    await server.close();
  }
});

test("json mode prints the same events as JSON lines", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    const { stdout } = await pi(["-p", "read README.md and summarize it", "--mode", "json", "--no-session"], {
      cwd,
      baseUrl: server.url,
    });

    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    const order = events.map((e) => e.type).filter((type, i, all) => type !== "message_update" || all[i - 1] !== "message_update");

    assert.deepEqual(order, [
      "agent_start",
      "turn_start",
      "context_snapshot",
      "model_request",
      "message_update",
      "model_response",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "context_snapshot",
      "model_request",
      "message_update",
      "model_response",
      "turn_end",
      "agent_end",
    ]);

    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    assert.equal(toolEnd.call.name, "read");
    assert.match(toolEnd.outcome.output, /A terminal harness/);

    const agentEnd = events.at(-1);
    assert.equal(agentEnd.reason, "end_turn");
    assert.equal(agentEnd.turns, 2);
    assert.ok(agentEnd.usage.cachedInputTokens > 0);
  } finally {
    await server.close();
  }
});

test("an extension adds a tool the model can call", async () => {
  const cwd = await workspace();
  const extension = join(cwd, "weather-ext.js");
  await writeFile(
    extension,
    `export default {
      name: "weather",
      tools: [{
        name: "weather",
        description: "Report the weather.",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        execute: (args) => ({ output: args.city + ": 14C, light rain" }),
      }],
    };\n`,
  );

  const server = await startFakeAnthropic({
    reply: (request) => {
      const answered = JSON.stringify(request.messages).includes("tool_result");
      return answered
        ? { stopReason: "end_turn", blocks: [{ type: "text", text: "It is raining in Berlin." }] }
        : {
            stopReason: "tool_use",
            blocks: [{ type: "tool_use", id: "toolu_w", name: "weather", input: { city: "Berlin" } }],
          };
    },
  });

  try {
    const { stdout } = await pi(["-p", "weather in Berlin", "-e", extension, "--mode", "json", "--no-session"], {
      cwd,
      baseUrl: server.url,
    });
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    assert.equal(toolEnd.call.name, "weather");
    assert.equal(toolEnd.outcome.output, "Berlin: 14C, light rain");
    assert.ok(server.requests[0].tools.some((t) => t.name === "weather"));
  } finally {
    await server.close();
  }
});

test("an extension refuses bash and the refusal is the tool result on the next call", async () => {
  const cwd = await workspace();
  const extension = join(cwd, "no-bash.js");
  await writeFile(
    extension,
    `export default {
      name: "no-bash",
      beforeToolCall: ({ call }) =>
        call.name === "bash" ? { output: "bash is disabled in this workspace", isError: true } : undefined,
    };\n`,
  );

  const server = await startFakeAnthropic({
    reply: (request) => {
      const answered = JSON.stringify(request.messages).includes("tool_result");
      return answered
        ? { stopReason: "end_turn", blocks: [{ type: "text", text: "bash is off, so I stopped." }] }
        : {
            stopReason: "tool_use",
            blocks: [{ type: "tool_use", id: "toolu_b", name: "bash", input: { command: "ls -la" } }],
          };
    },
  });

  try {
    const { stdout } = await pi(["-p", "list the files", "-e", extension, "--no-session"], {
      cwd,
      baseUrl: server.url,
    });
    assert.match(stdout, /refused by no-bash: bash is disabled in this workspace/);

    const toolResult = server.requests[1].messages.at(-1).content[0];
    assert.equal(toolResult.content, "bash is disabled in this workspace");
    assert.equal(toolResult.is_error, true);
  } finally {
    await server.close();
  }
});

test("the run writes a JSONL session with one record per message", async () => {
  const cwd = await workspace();
  const server = await startFakeAnthropic();
  try {
    const { stdout } = await pi(["-p", "read README.md and summarize it", "--session", "run.jsonl"], {
      cwd,
      baseUrl: server.url,
    });
    assert.match(stdout, /session · /);

    const { readFile } = await import("node:fs/promises");
    const records = (await readFile(join(cwd, "run.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.message.role),
      ["user", "assistant", "tool", "assistant"],
    );
  } finally {
    await server.close();
  }
});
