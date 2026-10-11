import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicClient, buildBody, decodeStream, toAnthropicMessages } from "../dist/index.js";

function sseBody(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      // Split mid-chunk so the parser has to buffer across reads.
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
      controller.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
      controller.close();
    },
  });
}

const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};

test("text and tool-call deltas map onto stream events", async () => {
  const events = await collect(
    decodeStream(
      sseBody([
        { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } },
        { type: "message_stop" },
      ]),
    ),
  );

  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => e.text),
    ["Reading"],
  );
  const toolDeltas = events.filter((e) => e.type === "tool_call_delta");
  assert.equal(toolDeltas.length, 2);
  assert.equal(toolDeltas[0].name, "read");

  const done = events.at(-1);
  assert.equal(done.type, "message_done");
  assert.equal(done.stopReason, "tool_use");
  assert.deepEqual(done.usage, {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteTokens: 0,
    outputTokens: 25,
  });
  const call = done.message.content[1];
  assert.deepEqual(call.arguments, { path: "README.md" });
  assert.equal(call.rawArguments, '{"path":"README.md"}');
});

test("the cache breakpoint sits on the last block of the transcript", () => {
  const first = buildBody(
    { model: "m", system: "you are pi", messages: [{ role: "user", content: "go" }] },
    "m",
    1024,
  );
  // Not on the system prompt: the breakpoint at the end already covers it.
  assert.equal(first.system[0].cache_control, undefined);
  assert.deepEqual(first.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });

  const second = buildBody(
    {
      model: "m",
      system: "you are pi",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "a", name: "read", arguments: { path: "x" }, rawArguments: "{}" }],
        },
        { role: "tool", toolCallId: "a", toolName: "read", content: "x contents" },
      ],
    },
    "m",
    1024,
  );
  // Exactly one breakpoint, and it moved to the new tail.
  const marked = second.messages.flatMap((m) => m.content).filter((b) => b.cache_control !== undefined);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].type, "tool_result");
  // The earlier messages are untouched, so the prefix stays stable.
  assert.equal(second.messages[0].content[0].cache_control, undefined);
});

test("consecutive tool results collapse into one Anthropic user message", () => {
  const body = toAnthropicMessages([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "a", name: "read", arguments: { path: "x" }, rawArguments: "{}" },
        { type: "tool_call", id: "b", name: "read", arguments: { path: "y" }, rawArguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "a", toolName: "read", content: "x contents" },
    { role: "tool", toolCallId: "b", toolName: "read", content: "boom", isError: true },
  ]);

  assert.equal(body.length, 3);
  assert.equal(body[2].role, "user");
  assert.equal(body[2].content.length, 2);
  assert.equal(body[2].content[1].is_error, true);
});

test("a call yields the raw request body and the raw response body", async () => {
  const sse = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  let sent = "";
  const fetch = async (_url, init) => {
    sent = init.body;
    return new Response(sse, { status: 200 });
  };
  const client = new AnthropicClient({ apiKey: "test-key", fetch, model: "m" });
  const events = [];
  for await (const event of client.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
    events.push(event);
  }

  assert.equal(events[0].type, "request");
  assert.equal(events[0].body, sent);
  assert.match(events[0].body, /"hi"/);
  assert.equal(events.at(-1).type, "response");
  assert.equal(events.at(-1).status, 200);
  assert.match(events.at(-1).body, /message_stop/);
  assert.equal(events[0].body.includes("test-key"), false);
});

test("a failed call still yields the response body before throwing", async () => {
  const fetch = async () => new Response("nope", { status: 500 });
  const client = new AnthropicClient({ apiKey: "test-key", fetch, model: "m" });
  const events = [];
  await assert.rejects(async () => {
    for await (const event of client.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }
  }, /failed with 500/);
  assert.equal(events[0].type, "request");
  assert.equal(events[1].type, "response");
  assert.equal(events[1].status, 500);
  assert.equal(events[1].body, "nope");
});
