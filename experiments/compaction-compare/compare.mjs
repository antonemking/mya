/**
 * Old summary-only compaction against the staged policy.
 * Synthetic transcripts, a stub model, no provider calls. Cost is $0.
 *
 *   node experiments/compaction-compare/compare.mjs
 *
 * Tokens are JSON length / 4 of the messages the stub was shown, the same
 * ruler for both policies. Overflow means that view is larger than the
 * window named on the row, not larger than the trigger threshold.
 */
import { Agent, NullSession } from "pi-agent";
import { compaction, estimateTokens } from "pi-compaction";

const SUMMARY_MARK = "compress a coding session";

class RecordingModel {
  constructor(provider, model) {
    this.provider = provider;
    this.defaultModel = model;
    this.calls = [];
  }

  async *stream(request) {
    this.calls.push(request);
    const summary = request.system?.includes(SUMMARY_MARK);
    yield {
      type: "message_done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: summary ? "Summary: parser.ts was read. Tests still open." : "Continuing." }],
      },
      stopReason: "end_turn",
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    };
  }
}

function codingTranscript({ toolChars, tools, fillerChars = 0 }) {
  const messages = [
    { role: "user", content: "Fix the null pointer in src/parser.ts and add a regression test." },
  ];
  for (let i = 0; i < tools; i += 1) {
    const id = `toolu_${i}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool_call", id, name: "read", arguments: { path: `src/file${i}.ts` }, rawArguments: "{}" }],
    });
    messages.push({
      role: "tool",
      toolCallId: id,
      toolName: "read",
      content: `file ${i}\n${"x".repeat(toolChars)}`,
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: `read file ${i}` }] });
  }
  if (fillerChars > 0) {
    messages.push({ role: "user", content: `notes\n${"y".repeat(fillerChars)}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: "noted" }] });
  }
  messages.push({ role: "user", content: "What is left?" });
  messages.push({ role: "assistant", content: [{ type: "text", text: "The regression test." }] });
  messages.push({ role: "user", content: "Run the tests." });
  messages.push({
    role: "assistant",
    content: [{ type: "tool_call", id: "toolu_tail", name: "bash", arguments: {}, rawArguments: "{}" }],
  });
  messages.push({ role: "tool", toolCallId: "toolu_tail", toolName: "bash", content: "12 passed" });
  messages.push({ role: "assistant", content: [{ type: "text", text: "Tests passed." }] });
  return messages;
}

function transcriptOfSize(targetTokens, extra = {}) {
  let chars = 1_000;
  let messages = codingTranscript({ toolChars: chars, tools: extra.tools ?? 1, fillerChars: extra.fillerChars ?? 0 });
  while (estimateTokens(messages) < targetTokens && chars < 4_000_000) {
    chars += chars < 20_000 ? 1_000 : 10_000;
    messages = codingTranscript({ toolChars: chars, tools: extra.tools ?? 1, fillerChars: extra.fillerChars ?? 0 });
  }
  return messages;
}

async function run(messages, extension, provider, model) {
  const client = new RecordingModel(provider, model);
  await new Agent({
    model: client,
    modelName: model,
    tools: [],
    system: "You are a coding agent.",
    session: new NullSession("compare"),
    messages: messages.map((message) => structuredClone(message)),
    extensions: [extension],
  }).run("continue");
  return analyze(client);
}

function analyze(model) {
  const summaryCalls = model.calls.filter((call) => call.system?.includes(SUMMARY_MARK));
  const taskCalls = model.calls.filter((call) => !call.system?.includes(SUMMARY_MARK));
  const task = taskCalls.at(-1);
  const taskTokens = task ? estimateTokens(task.messages) : null;
  const summaryTokens = summaryCalls.reduce((sum, call) => sum + estimateTokens(call.messages), 0);
  return {
    taskTokens,
    summaryCalls: summaryCalls.length,
    summaryTokens,
    totalTokens: (taskTokens ?? 0) + summaryTokens,
  };
}

function row(name, window, policy, result, unmanagedTokens) {
  return {
    name,
    policy,
    window,
    unmanagedTokens,
    ...result,
    overflow: result.taskTokens !== null && result.taskTokens > window,
  };
}

const scenarios = [
  {
    name: "tight 32k, bulky middle",
    window: 32_000,
    messages: transcriptOfSize(28_000),
    provider: "openai",
    model: "llama3",
    old: compaction({ contextWindow: 32_000, log: () => {} }),
    staged: compaction({ staged: true, modelWindow: false, contextWindow: 32_000, log: () => {} }),
  },
  {
    name: "32k, between soft and hard",
    window: 32_000,
    messages: transcriptOfSize(22_000),
    provider: "openai",
    model: "llama3",
    old: compaction({ contextWindow: 32_000, log: () => {} }),
    staged: compaction({ staged: true, modelWindow: false, contextWindow: 32_000, log: () => {} }),
  },
  {
    name: "8k, elision cannot cover a long user note",
    window: 8_000,
    messages: codingTranscript({ toolChars: 20_000, tools: 1, fillerChars: 40_000 }),
    provider: "openai",
    model: "llama3",
    old: compaction({ contextWindow: 8_000, log: () => {} }),
    staged: compaction({ staged: true, modelWindow: false, contextWindow: 8_000, log: () => {} }),
  },
  {
    name: "50k transcript, fixed 200k vs a 32k window",
    window: 32_000,
    messages: transcriptOfSize(50_000),
    provider: "openai",
    model: "llama3",
    old: compaction({ log: () => {} }),
    staged: compaction({ staged: true, modelWindow: false, contextWindow: 32_000, log: () => {} }),
  },
  {
    name: "200k transcript, fixed 200k vs openai/gpt-5.5",
    window: 1_050_000,
    messages: transcriptOfSize(200_000, { tools: 2 }),
    provider: "openai",
    model: "gpt-5.5",
    old: compaction({ log: () => {} }),
    staged: compaction({ staged: true, log: () => {} }),
  },
  {
    name: "200k transcript, fixed 200k vs openai-codex/gpt-5.5",
    window: 272_000,
    messages: transcriptOfSize(200_000, { tools: 2 }),
    provider: "openai-codex",
    model: "gpt-5.5",
    old: compaction({ log: () => {} }),
    staged: compaction({ staged: true, log: () => {} }),
  },
];

const results = [];
for (const scenario of scenarios) {
  const unmanagedTokens = estimateTokens(scenario.messages);
  const old = await run(scenario.messages, scenario.old, scenario.provider, scenario.model);
  const staged = await run(scenario.messages, scenario.staged, scenario.provider, scenario.model);
  results.push({
    name: scenario.name,
    unmanagedTokens,
    old: row(scenario.name, scenario.window, "summary-only", old, unmanagedTokens),
    staged: row(scenario.name, scenario.window, "staged", staged, unmanagedTokens),
  });
}

console.log(JSON.stringify({ costUsd: 0, results }, null, 2));

const failures = [];
function expect(name, condition) {
  if (!condition) failures.push(name);
}

const byName = Object.fromEntries(results.map((result) => [result.name, result]));
const tight = byName["tight 32k, bulky middle"];
expect("tight: old summarizes", tight.old.summaryCalls === 1);
expect("tight: staged does not summarize", tight.staged.summaryCalls === 0);
expect("tight: neither overflows 32k", tight.old.overflow === false && tight.staged.overflow === false);
expect("tight: staged sends fewer tokens overall", tight.staged.totalTokens < tight.old.totalTokens);

const between = byName["32k, between soft and hard"];
expect("between: old does not summarize", between.old.summaryCalls === 0);
expect("between: staged does not summarize", between.staged.summaryCalls === 0);
expect("between: staged view is smaller", between.staged.taskTokens < between.old.taskTokens);

const notes = byName["8k, elision cannot cover a long user note"];
expect("notes: both summarize", notes.old.summaryCalls === 1 && notes.staged.summaryCalls === 1);
expect("notes: staged summary is smaller", notes.staged.summaryTokens < notes.old.summaryTokens);

const small = byName["50k transcript, fixed 200k vs a 32k window"];
expect("small: old overflows 32k", small.old.overflow === true);
expect("small: old does not summarize under the 200k default", small.old.summaryCalls === 0);
expect("small: staged fits in 32k", small.staged.overflow === false);

const gpt = byName["200k transcript, fixed 200k vs openai/gpt-5.5"];
expect("gpt-5.5: old summarizes", gpt.old.summaryCalls === 1);
expect("gpt-5.5: staged does not summarize", gpt.staged.summaryCalls === 0);
expect("gpt-5.5: neither overflows 1,050,000", gpt.old.overflow === false && gpt.staged.overflow === false);

const codex = byName["200k transcript, fixed 200k vs openai-codex/gpt-5.5"];
expect("codex: old summarizes", codex.old.summaryCalls === 1);
expect("codex: staged does not summarize", codex.staged.summaryCalls === 0);
expect("codex: neither overflows 272k", codex.old.overflow === false && codex.staged.overflow === false);

if (failures.length > 0) {
  console.error(`compare failed: ${failures.join("; ")}`);
  process.exit(1);
}
