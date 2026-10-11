import { createServer } from "node:http";
import { defaultReply } from "./fakeAnthropic.js";

/**
 * A test fixture, not a provider. It speaks the chat completions SSE format
 * so the real OpenAI client, the real loop, the real tools, and the real
 * views all run. The scripted reply is shared with the Anthropic fixture, so
 * both providers answer the same way and any difference is wire format.
 */
export function startFakeOpenAI(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      requests.push(request);

      if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing bearer token" } }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const reply = (options.reply ?? defaultReply)(request);
      for (const chunk of toChunks(reply, requests.length)) res.write(chunk);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function toChunks(reply, callNumber) {
  const out = [];
  const push = (payload) => out.push(`data: ${JSON.stringify(payload)}\n\n`);
  const frame = (delta, finish = null) => ({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    model: "gpt-fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  push(frame({ role: "assistant", content: "" }));

  let toolIndex = 0;
  for (const block of reply.blocks) {
    if (block.type === "text") {
      for (const piece of chunkText(block.text)) push(frame({ content: piece }));
      continue;
    }
    const index = toolIndex++;
    push(frame({ tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }));
    for (const piece of chunkText(JSON.stringify(block.input), 12)) {
      push(frame({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  }

  push(frame({}, reply.stopReason === "tool_use" ? "tool_calls" : "stop"));
  // The usage-only frame arrives last when stream_options.include_usage is set.
  push({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 1200 * callNumber,
      completion_tokens: 48,
      total_tokens: 1200 * callNumber + 48,
      prompt_tokens_details: { cached_tokens: callNumber > 1 ? 900 : 0 },
    },
  });
  out.push("data: [DONE]\n\n");
  return out;
}

function chunkText(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}
