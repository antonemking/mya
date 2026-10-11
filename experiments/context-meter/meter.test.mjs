import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent } from "pi-agent";
import { classifyEnding, contextMeter, estimateTokens, lookupWindow, overflowDetail, promptTokens } from "./meter.mjs";
import { formatReport, loadRecords, summarize } from "./report.mjs";

const reportPath = fileURLToPath(new URL("./report.mjs", import.meta.url));

test("lookupWindow uses the provider's real input budget", () => {
  assert.equal(lookupWindow("anthropic", "claude-sonnet-4-5-20250929", {}).window, 200_000);
  assert.equal(lookupWindow("anthropic", "claude-sonnet-4-5", {}).window, 200_000);
  assert.match(lookupWindow("anthropic", "claude-sonnet-4-5", {}).windowNote, /1M/);
  assert.equal(lookupWindow("openai", "gpt-4.1", {}).window, 1_047_576);
  assert.equal(lookupWindow("openai", "gpt-5.5", {}).window, 1_050_000);
  const codex = lookupWindow("openai-codex", "gpt-5.5", {});
  assert.equal(codex.window, 272_000);
  assert.match(codex.windowNote, /400k/);
  assert.equal(codex.windowSource, "table");
});

test("a dated snapshot uses the base model, and a different model does not", () => {
  assert.equal(lookupWindow("openai", "gpt-5.5-2026-04-23", {}).window, 1_050_000);
  assert.equal(lookupWindow("openai", "gpt-4.1-2025-04-14", {}).window, 1_047_576);
  assert.equal(lookupWindow("anthropic", "claude-sonnet-4-5-2026-01-15", {}).window, 200_000);
  assert.equal(lookupWindow("openai", "gpt-5.5-pro", {}).window, null);
  assert.equal(lookupWindow("openai", "gpt-5.5-pro-2026-04-23", {}).window, null);
  assert.equal(lookupWindow("openai", "llama3", {}).windowSource, "unknown");
});

test("MYA_CONTEXT_WINDOW overrides the table and PI_CONTEXT_WINDOW is ignored", () => {
  const overridden = lookupWindow("anthropic", "claude-sonnet-4-5", { MYA_CONTEXT_WINDOW: "200_000" });
  assert.equal(overridden.window, 200_000);
  assert.equal(overridden.windowSource, "env");

  const fromPolicy = lookupWindow("anthropic", "claude-sonnet-4-5", { PI_CONTEXT_WINDOW: "1000" });
  assert.equal(fromPolicy.window, 200_000);
  assert.equal(fromPolicy.windowSource, "table");

  const invalid = lookupWindow("openai", "gpt-4.1", { MYA_CONTEXT_WINDOW: "nope" });
  assert.equal(invalid.window, null);
  assert.match(invalid.windowNote, /not a positive integer/);
  assert.equal(lookupWindow("openai", "gpt-4.1", { MYA_CONTEXT_WINDOW: "0" }).window, null);
});

test("prompt tokens add prefill and cache, and the estimate is chars/4 of the request", () => {
  assert.equal(promptTokens({ inputTokens: 10, cachedInputTokens: 3, cacheWriteTokens: 2, outputTokens: 99 }), 15);
  const snapshot = { system: "abcd", tools: [], messages: [{ role: "user", content: "hi" }] };
  const json = JSON.stringify({ system: "abcd", tools: [], messages: [{ role: "user", content: "hi" }] });
  assert.equal(estimateTokens(snapshot), Math.round(json.length / 4));
});

test("classifyEnding separates context, the turn cap, and other failures", () => {
  const tooLong = "prompt is too long: 200001 tokens > 200000 maximum";
  assert.equal(classifyEnding({ reason: "error", error: tooLong }).endedBy, "context");
  assert.match(classifyEnding({ reason: "error", error: tooLong }).detail, /prompt is too long/);

  const body = overflowDetail('{"error":{"code":"context_length_exceeded","message":"maximum context length"}}');
  assert.equal(classifyEnding({ reason: "error", error: "openai request failed with 400", errorBodyDetail: body }).endedBy, "context");

  const limit = classifyEnding({
    reason: "error",
    error: "codex usage limit reached (429): slow down",
    errorBodyDetail: overflowDetail("codex usage limit reached (429): slow down"),
  });
  assert.equal(limit.endedBy, "other_error");

  assert.equal(
    classifyEnding({ reason: "end_turn", contextStop: true }).endedBy,
    "context",
  );
  assert.equal(
    classifyEnding({ reason: "max_turns", contextStop: true, error: tooLong, errorBodyDetail: body }).endedBy,
    "turn_cap",
  );
  assert.equal(classifyEnding({ reason: "end_turn", contextStop: false }).endedBy, "completed");
  assert.equal(classifyEnding({ reason: "aborted", error: tooLong }).endedBy, "aborted");
  assert.equal(overflowDetail('data: {"delta":{"stop_reason":"max_tokens"}}'), null);
  assert.match(overflowDetail("the context window is large"), /context window/);
});

test("a finished run records peak usage and does not estimate", () => {
  const rows = [];
  const meter = contextMeter({ env: {}, write: (record) => rows.push(record) });
  meter.onEvent(start());
  meter.onEvent(snapshot("small"));
  meter.onEvent(turnEnd({ inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 9 }));
  meter.onEvent(snapshot("x".repeat(400)));
  meter.onEvent(turnEnd({ inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }));
  meter.onEvent(end("end_turn"));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].endedBy, "completed");
  assert.equal(rows[0].peakUsageTokens, 125);
  assert.equal(rows[0].peakTokens, 125);
  assert.equal(rows[0].peakSource, "usage");
  assert.equal(rows[0].peakEstimateTokens, null);
  assert.equal(rows[0].window, 200_000);
  assert.equal(rows[0].ratio, 125 / 200_000);
  assert.equal(rows[0].sessionFile, "/tmp/s.jsonl");
});

test("a context error before turn_end uses the request estimate", () => {
  const rows = [];
  const meter = contextMeter({ env: {}, write: (record) => rows.push(record) });
  meter.onEvent(start());
  meter.onEvent(snapshot("x".repeat(80)));
  meter.onEvent({
    type: "model_response",
    status: 400,
    body: '{"type":"error","error":{"message":"prompt is too long: 200001 tokens > 200000 maximum"}}',
  });
  meter.onEvent(end("error", "anthropic request failed with 400"));

  assert.equal(rows[0].endedBy, "context");
  assert.equal(rows[0].reason, "error");
  assert.equal(rows[0].peakUsageTokens, null);
  assert.equal(rows[0].peakSource, "estimate");
  assert.equal(rows[0].peakTokens, rows[0].peakEstimateTokens);
  assert.ok(rows[0].peakEstimateTokens > 0);
  assert.match(rows[0].detail, /prompt is too long/);
  assert.ok(rows[0].detail.length <= 180);
  assert.equal(rows[0].body, undefined);
});

test("usage wins when it is already larger than the failed request estimate", () => {
  const rows = [];
  const meter = contextMeter({ env: {}, write: (record) => rows.push(record) });
  meter.onEvent(start());
  meter.onEvent(turnEnd({ inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }));
  meter.onEvent(snapshot("hi"));
  meter.onEvent({ type: "model_response", status: 400, body: "context_length_exceeded" });
  meter.onEvent(end("error", "openai request failed with 400"));

  assert.equal(rows[0].endedBy, "context");
  assert.equal(rows[0].peakSource, "usage");
  assert.equal(rows[0].peakTokens, 1000);
  assert.ok(rows[0].peakEstimateTokens < 1000);
});

test("a successful body that mentions context is not an overflow, and the turn cap wins", () => {
  const rows = [];
  const meter = contextMeter({ env: {}, write: (record) => rows.push(record) });
  meter.onEvent(start());
  meter.onEvent({ type: "model_response", status: 200, body: 'data: {"text":"the context window is large"}\n\n' });
  meter.onEvent(turnEnd({ inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }));
  meter.onEvent(end("end_turn"));
  assert.equal(rows[0].endedBy, "completed");

  meter.onEvent(start());
  meter.onEvent({
    type: "model_response",
    status: 200,
    body: 'data: {"delta":{"stop_reason":"model_context_window_exceeded"}}',
  });
  meter.onEvent(turnEnd({ inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
  meter.onEvent(end("max_turns"));
  assert.equal(rows[1].endedBy, "turn_cap");
  assert.equal(rows[1].peakSource, "usage");

  meter.onEvent(start());
  meter.onEvent({
    type: "model_response",
    status: 200,
    body: 'data: {"delta":{"stop_reason":"model_context_window_exceeded"}}',
  });
  meter.onEvent(turnEnd({ inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
  meter.onEvent(end("end_turn"));
  assert.equal(rows[2].endedBy, "context");
  assert.equal(rows[2].detail, "model_context_window_exceeded");

  meter.onEvent(start());
  meter.onEvent({
    type: "model_response",
    status: 200,
    body: 'data: {"delta":{"stop_reason":"model_context_window_exceeded"}}',
  });
  meter.onEvent(turnEnd({ inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
  meter.onEvent(snapshot("next"));
  meter.onEvent(end("error", "socket hang up"));
  assert.equal(rows[3].endedBy, "other_error");
  assert.equal(rows[3].detail, "socket hang up");
});

test("a later run does not keep the previous peak, and the log path follows the agent cwd", () => {
  const files = [];
  const rows = [];
  const meter = contextMeter({
    env: {},
    write: (record, file) => {
      rows.push(record);
      files.push(file);
    },
  });
  meter.onEvent(start({ cwd: "/work" }));
  meter.onEvent(turnEnd({ inputTokens: 80, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }));
  meter.onEvent(end("end_turn"));
  meter.onEvent(start({ cwd: "/other", sessionId: "second" }));
  meter.onEvent(turnEnd({ inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }));
  meter.onEvent(end("end_turn"));

  assert.equal(rows[0].peakTokens, 80);
  assert.equal(rows[1].peakTokens, 5);
  assert.equal(rows[1].sessionId, "second");
  assert.equal(files[0], join("/work", ".mya", "context-meter.jsonl"));
  assert.equal(files[1], join("/other", ".mya", "context-meter.jsonl"));
});

test("MYA_CONTEXT_METER_FILE overrides the default log, and a write failure does not escape", () => {
  const rows = [];
  const chosen = contextMeter({
    env: { MYA_CONTEXT_METER_FILE: "/tmp/meter.jsonl" },
    write: (record, file) => rows.push(file),
  });
  chosen.onEvent(start());
  chosen.onEvent(end("end_turn"));
  assert.equal(rows[0], "/tmp/meter.jsonl");

  const errors = [];
  const broken = contextMeter({
    env: {},
    write: () => {
      throw new Error("disk full");
    },
    stderr: (line) => errors.push(line),
  });
  broken.onEvent(start());
  assert.doesNotThrow(() => broken.onEvent(end("end_turn")));
  assert.match(errors[0], /mya: context meter: disk full/);
});

test("summarize reports the overflow rate and the median peak per model", () => {
  const summary = summarize([
    { endedBy: "context", provider: "anthropic", model: "m", window: 100, ratio: 1.2, peakTokens: 120, sessionId: "a", peakSource: "estimate", turns: 4 },
    { endedBy: "turn_cap", provider: "anthropic", model: "m", window: 100, ratio: 0.5, peakTokens: 50, sessionId: "b", peakSource: "usage", turns: 30 },
    { endedBy: "completed", provider: "openai", model: "gpt-4.1", window: 100, ratio: 0.1, peakTokens: 10, sessionId: "c", turns: 1 },
    { endedBy: "other_error", provider: "stub", model: "stub-1", window: null, sessionId: "d", turns: 1 },
    { endedBy: "aborted", provider: "stub", model: "stub-1", window: null, sessionId: "e", turns: 1 },
  ]);

  assert.equal(summary.runs, 5);
  assert.equal(summary.overflowRate, 1 / 5);
  assert.equal(summary.turnCapRate, 1 / 5);
  assert.equal(summary.windowUnknown, 2);
  assert.equal(summary.models.find((model) => model.model === "anthropic/m").medianRatio, 0.85);
  assert.equal(summary.models.find((model) => model.model === "stub/stub-1").medianRatio, null);

  const text = formatReport(summary);
  assert.match(text, /^overflow rate: 1\/5 \(20\.0%\)/);
  assert.match(text, /turn-cap rate: 1\/5 \(20\.0%\)/);
  assert.match(text, /median peak\/window 85\.0%/);
  assert.match(text, /median peak\/window —/);
  assert.match(text, /context endings:\n {2}a {2}anthropic\/m/);
  assert.match(text, /turn-cap endings:\n {2}b {2}anthropic\/m/);
});

test("unreadable lines are skipped, and an empty log is not an overflow", () => {
  const loaded = loadRecords('{"endedBy":"completed","provider":"openai","model":"gpt-4.1","window":10,"ratio":0.2}\nnot json\n\n');
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.records.length, 1);
  assert.equal(summarize([]).overflowRate, null);
  assert.equal(formatReport(summarize([])), "no runs\n");
  assert.match(formatReport(summarize([]), { skipped: 2 }), /skipped 2 unreadable lines/);
});

test("the report exits 1 when the log is missing and 0 when it is empty", async () => {
  const missing = spawnSync(process.execPath, [reportPath, join(tmpdir(), "no-such-context-meter.jsonl")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no log/);

  const dir = await mkdtemp(join(tmpdir(), "meter-report-"));
  const file = join(dir, "empty.jsonl");
  await writeFile(file, "");
  const empty = spawnSync(process.execPath, [reportPath, file], { encoding: "utf8" });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "no runs\n");
});

test("the extension writes one line and does not change the run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "meter-agent-"));
  const file = join(cwd, "meter.jsonl");
  const plain = new Agent({ model: scripted([answer("ok")]), cwd, tools: [] });
  const meter = contextMeter({ env: { MYA_CONTEXT_METER_FILE: file, MYA_CONTEXT_WINDOW: "8000" } });
  const metered = new Agent({ model: scripted([answer("ok")]), cwd, tools: [], extensions: [meter] });

  const left = await plain.run("hi");
  const right = await metered.run("hi");

  assert.equal(right.reason, left.reason);
  assert.equal(right.turns, left.turns);
  assert.deepEqual(right.messages, left.messages);
  assert.equal(metered.model.calls[0].tools.length, 0);

  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.endedBy, "completed");
  assert.equal(row.reason, "end_turn");
  assert.equal(row.peakUsageTokens, 10);
  assert.equal(row.peakSource, "usage");
  assert.equal(row.window, 8000);
  assert.equal(row.windowSource, "env");
});

test("a provider context error and the turn cap are logged from a real run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "meter-agent-"));
  const file = join(cwd, "meter.jsonl");
  const env = { MYA_CONTEXT_METER_FILE: file, MYA_CONTEXT_WINDOW: "200000" };

  const failing = new Agent({
    model: scripted([{ throw: new Error("prompt is too long: 200001 tokens > 200000 maximum") }]),
    cwd,
    tools: [],
    extensions: [contextMeter({ env })],
  });
  const failed = await failing.run("hi");
  assert.equal(failed.reason, "error");
  assert.equal(failed.messages.length, 1);

  const capped = new Agent({
    model: scripted([
      toolCall("call_1"),
      toolCall("call_2"),
    ]),
    cwd,
    tools: [],
    maxTurns: 1,
    extensions: [contextMeter({ env })],
  });
  const stopped = await capped.run("loop");
  assert.equal(stopped.reason, "max_turns");
  assert.equal(stopped.turns, 1);

  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].endedBy, "context");
  assert.equal(lines[0].peakSource, "estimate");
  assert.ok(lines[0].peakEstimateTokens > 0);
  assert.equal(lines[1].endedBy, "turn_cap");
  assert.equal(lines[1].reason, "max_turns");
  assert.equal(lines[1].peakUsageTokens, 10);
  assert.equal(lines[1].peakSource, "usage");
});

function start(overrides = {}) {
  return {
    type: "agent_start",
    sessionId: "s",
    sessionFile: "/tmp/s.jsonl",
    cwd: "/tmp",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    at: 1,
    ...overrides,
  };
}

function snapshot(text) {
  return {
    type: "context_snapshot",
    turn: 1,
    model: "claude-sonnet-4-5-20250929",
    system: text,
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    at: 2,
  };
}

function turnEnd(usage) {
  return { type: "turn_end", turn: 1, stopReason: "end_turn", usage, toolCalls: 0, at: 3 };
}

function end(reason, error) {
  return { type: "agent_end", reason, turns: 1, usage: {}, ...(error ? { error } : {}), at: 4 };
}

function answer(text, usage) {
  return {
    content: [{ type: "text", text }],
    usage,
  };
}

function toolCall(id) {
  return {
    content: [{ type: "tool_call", id, name: "nope", arguments: {}, rawArguments: "{}" }],
  };
}

function scripted(steps) {
  const pending = [...steps];
  return {
    provider: "stub",
    defaultModel: "stub-1",
    calls: [],
    async *stream(request) {
      this.calls.push(request);
      const step = pending.shift();
      if (!step) throw new Error("stub model ran out of script");
      if (step.throw) throw step.throw;
      for (const block of step.content) {
        if (block.type === "text") yield { type: "text_delta", text: block.text };
        else {
          yield {
            type: "tool_call_delta",
            index: 0,
            id: block.id,
            name: block.name,
            argumentsDelta: block.rawArguments,
          };
        }
      }
      yield {
        type: "message_done",
        message: { role: "assistant", content: step.content },
        stopReason: step.content.some((block) => block.type === "tool_call") ? "tool_use" : "end_turn",
        usage: step.usage ?? { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
      };
    },
  };
}
