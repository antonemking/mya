import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatBody,
  createModelClient,
  decodeChatStream,
  isProviderName,
  providerNames,
  toOpenAiMessages,
} from "../dist/index.js";

function sseBody(frames) {
  const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      // Split mid-chunk so the parser has to buffer across reads.
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

const frame = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

test("chat completion deltas map onto the same stream events", async () => {
  const events = await collect(
    decodeChatStream(
      sseBody([
        frame({ role: "assistant", content: "" }),
        frame({ content: "Reading" }),
        frame({
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }],
        }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }),
        frame({}, "tool_calls"),
        {
          choices: [],
          usage: { prompt_tokens: 140, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } },
        },
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
  assert.equal(toolDeltas[0].id, "call_1");

  const done = events.at(-1);
  assert.equal(done.type, "message_done");
  assert.equal(done.stopReason, "tool_use");
  // prompt_tokens includes cached tokens upstream; inputTokens stays "fresh prefill".
  assert.deepEqual(done.usage, {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteTokens: 0,
    outputTokens: 25,
  });

  const call = done.message.content[1];
  assert.equal(call.type, "tool_call");
  assert.deepEqual(call.arguments, { path: "README.md" });
});

test("tool results become their own role and the system prompt leads", () => {
  const messages = toOpenAiMessages(
    [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_call", id: "a", name: "read", arguments: { path: "x" }, rawArguments: '{"path":"x"}' },
        ],
      },
      { role: "tool", toolCallId: "a", toolName: "read", content: "x contents" },
    ],
    "you are pi",
  );

  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"x"}');
  assert.equal(messages[3].tool_call_id, "a");
  assert.equal(messages[3].content, "x contents");
});

test("an assistant message with only tool calls sends null content", () => {
  const messages = toOpenAiMessages([
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "a", name: "read", arguments: {}, rawArguments: "{}" }],
    },
  ]);
  assert.equal(messages[0].content, null);
});

test("the max tokens field follows the endpoint", () => {
  const forOpenAi = buildChatBody({ model: "m", messages: [] }, "m", 512, "max_completion_tokens");
  const forClone = buildChatBody({ model: "m", messages: [] }, "m", 512, "max_tokens");
  assert.equal(forOpenAi.max_completion_tokens, 512);
  assert.equal(forClone.max_tokens, 512);
  assert.deepEqual(forOpenAi.stream_options, { include_usage: true });
});

test("the registry hands back a client by name and refuses anything else", () => {
  assert.deepEqual([...providerNames], ["anthropic", "openai", "openai-codex"]);
  assert.ok(isProviderName("openai"));
  assert.ok(!isProviderName("nope"));

  const client = createModelClient("openai", { apiKey: "test" });
  assert.equal(client.provider, "openai");
  assert.equal(typeof client.stream, "function");

  const anthropic = createModelClient("anthropic", { apiKey: "test" });
  assert.equal(anthropic.provider, "anthropic");

  assert.throws(() => createModelClient("gemini", { apiKey: "test" }), /unknown provider: gemini/);
});
