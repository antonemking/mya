import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { eventItems, sanitizeEvent, summarizeMessage, viz } from "../dist/index.js";

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Collects SSE items until `until` says stop. */
function subscribe(url, until) {
  return new Promise((resolve, reject) => {
    const items = [];
    const req = request(`${url}/events`, (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          items.push(JSON.parse(data.slice(6)));
          if (until(items)) {
            req.destroy();
            resolve(items);
            return;
          }
        }
      });
    });
    req.on("error", (error) => (error.code === "ECONNRESET" ? resolve(items) : reject(error)));
    req.end();
  });
}

const contextInput = (messages) => ({
  messages,
  turn: 1,
  cwd: "/tmp",
  model: "gpt-5.5",
  system: "you are mya",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  modelClient: {},
  session: {},
  append: async () => {},
});

test("serves the page on localhost and refuses a foreign Host", async () => {
  const extension = viz({ port: 0, open: false, log: () => {} });
  try {
    const url = await extension.url;
    const page = await get(url);
    assert.equal(page.status, 200);
    assert.match(page.body, /mya · viz/);

    const rebound = await get(url, { host: "evil.example" });
    assert.equal(rebound.status, 403);
  } finally {
    extension.close();
  }
});

test("a late viewer gets the history, then live items", async () => {
  const extension = viz({ port: 0, open: false, log: () => {} });
  try {
    const url = await extension.url;
    extension.onEvent({ type: "agent_start", sessionId: "s1", cwd: "/tmp", model: "gpt-5.5", provider: "openai-codex", at: 1 });
    extension.onEvent({ type: "turn_start", turn: 1, at: 2 });
    const messages = [{ role: "user", content: "read README.md" }];
    assert.equal(extension.transformContext(contextInput(messages)), messages, "context passes through untouched");
    extension.onEvent({
      type: "context_snapshot",
      turn: 1,
      model: "gpt-5.5",
      system: "you are mya",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      messages,
      at: 2,
    });

    const received = subscribe(url, (items) => items.some((i) => i.kind === "event" && i.event.type === "agent_end"));
    await new Promise((done) => setTimeout(done, 50));
    extension.onEvent({ type: "agent_end", reason: "end_turn", turns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 3 });

    const items = await received;
    const kinds = items.map((i) => (i.kind === "event" ? i.event.type : i.kind));
    assert.deepEqual(kinds, ["hello", "history-start", "agent_start", "turn_start", "context", "history-end", "agent_end"]);

    const context = items.find((i) => i.kind === "context");
    assert.equal(context.system, "you are mya");
    assert.equal(context.tools[0].name, "read");
    assert.deepEqual(context.messages[0], { role: "user", chars: 14, preview: "read README.md" });
    assert.ok(items.every((i) => i.kind !== "event" || typeof i.t === "number"));
  } finally {
    extension.close();
  }
});

test("encrypted reasoning and huge tool output never reach the page", () => {
  const turnEnd = sanitizeEvent({
    type: "turn_end",
    turn: 1,
    stopReason: "tool_use",
    usage: {},
    toolCalls: 1,
    at: 1,
    message: {
      role: "assistant",
      content: [
        { type: "tool_call", id: "c", name: "read", arguments: {}, rawArguments: "{}" },
        { type: "opaque", provider: "openai-codex", data: { items: [{ encrypted_content: "SECRET" }] } },
      ],
    },
  });
  assert.ok(!JSON.stringify(turnEnd).includes("SECRET"));
  assert.equal(turnEnd.message.content[1].provider, "openai-codex");
  assert.ok(turnEnd.message.content[1].bytes > 0);

  const big = sanitizeEvent({
    type: "tool_execution_end",
    turn: 1,
    call: { id: "c", name: "read", arguments: {}, rawArguments: "{}" },
    outcome: { output: "x".repeat(50_000) },
    durationMs: 1,
    at: 1,
  });
  assert.ok(big.outcome.output.length < 21_000);
  assert.match(big.outcome.output, /50000 chars total/);
});

test("a recorded run keeps its timestamps and drops the raw body", async () => {
  const events = [
    { type: "agent_start", sessionId: "s1", cwd: "/tmp", model: "m", provider: "anthropic", at: 1000 },
    { type: "turn_start", turn: 1, at: 1100 },
    {
      type: "context_snapshot",
      turn: 1,
      model: "m",
      system: "you are mya",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "read README.md" }],
      at: 1150,
    },
    { type: "model_request", turn: 1, body: "{\"secret\":true}", at: 1200 },
    { type: "message_update", turn: 1, delta: { kind: "text", text: "hi" } },
    { type: "model_response", turn: 1, status: 200, body: "raw-sse", at: 2000 },
    { type: "agent_end", reason: "end_turn", turns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, at: 2100 },
  ];
  const items = eventItems(events);
  assert.deepEqual(items.map((item) => item.t), [1000, 1100, 1150, 1200, 1600, 2000, 2100]);
  const context = items.find((item) => item.kind === "context");
  assert.equal(context.system, "you are mya");
  assert.equal(context.tools[0].name, "read");
  assert.equal(context.messages[0].preview, "read README.md");
  const request = items.find((item) => item.kind === "event" && item.event.type === "model_request");
  assert.equal(request.event.chars, events.find((event) => event.type === "model_request").body.length);
  assert.equal(request.event.body, undefined);
  assert.ok(!JSON.stringify(items).includes("raw-sse"));

  const extension = viz({ port: 0, open: false, log: () => {} });
  try {
    const url = await extension.url;
    const received = subscribe(url, (seen) => seen.some((item) => item.kind === "event" && item.event.type === "agent_end"));
    extension.load(events);
    const seen = await received;
    const types = seen.filter((item) => item.kind === "event").map((item) => item.event.type);
    assert.deepEqual(types, ["agent_start", "turn_start", "model_request", "message_update", "model_response", "agent_end"]);
    assert.equal(seen.filter((item) => item.kind === "context").length, 1);
  } finally {
    extension.close();
  }
});

test("assistant messages are summarized without their opaque payloads", () => {
  const summary = summarizeMessage({
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool_call", id: "c", name: "read", arguments: {}, rawArguments: '{"path":"a"}' },
      { type: "opaque", provider: "openai-codex", data: { items: [{ encrypted_content: "SECRET" }] } },
    ],
  });
  assert.equal(summary.role, "assistant");
  assert.match(summary.preview, /reading\n→ read\(\{"path":"a"\}\)/);
  assert.ok(!summary.preview.includes("SECRET"));
});
