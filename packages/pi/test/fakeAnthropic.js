import { createServer } from "node:http";

/**
 * A test fixture, not a provider. It speaks the Anthropic SSE wire format so
 * the real pi-ai decoder, the real loop, the real tools, and the real views
 * all run. The scripted reply on the second call is built from the tool result
 * in the request, so the answer depends on the file that was read.
 */
export function startFakeAnthropic(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      requests.push(request);

      if (req.headers["x-api-key"] === undefined) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing x-api-key" } }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const reply = (options.reply ?? defaultReply)(request);
      for (const event of toSse(reply, requests.length)) {
        res.write(event);
      }
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export function defaultReply(request) {
  const toolResult = lastToolResult(request);
  if (!toolResult) {
    return {
      stopReason: "tool_use",
      blocks: [
        { type: "text", text: "I'll read the file first." },
        { type: "tool_use", id: "toolu_readme_1", name: "read", input: { path: "README.md" } },
      ],
    };
  }
  return { stopReason: "end_turn", blocks: [{ type: "text", text: summarize(toolResult) }] };
}

function lastToolResult(request) {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    // Anthropic carries tool results inside a user message; OpenAI gives them
    // their own role. This fixture is used for both.
    if (message.role === "tool") return typeof message.content === "string" ? message.content : "";
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const block = message.content.find((b) => b.type === "tool_result");
    if (block) return typeof block.content === "string" ? block.content : "";
  }
  return undefined;
}

/** Derived from the tool result, so the answer changes when the file changes. */
function summarize(toolResult) {
  const lines = toolResult.split("\n").map((line) => line.replace(/^\s*\d+\t/, ""));
  const heading = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? "the file";
  const sections = lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3).trim());
  const firstParagraph = lines.find((line) => line !== "" && !line.startsWith("#"))?.trim() ?? "";
  return [
    `${heading}: ${firstParagraph}`,
    sections.length > 0 ? `It covers ${sections.join(", ")}.` : "",
    `The file is ${lines.length} lines long.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function toSse(reply, callNumber) {
  const out = [];
  const push = (type, payload) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);

  push("message_start", {
    message: {
      usage: {
        input_tokens: 1200 * callNumber,
        cache_read_input_tokens: callNumber > 1 ? 900 : 0,
        cache_creation_input_tokens: callNumber === 1 ? 900 : 0,
        output_tokens: 1,
      },
    },
  });

  reply.blocks.forEach((block, index) => {
    if (block.type === "text") {
      push("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const chunk of chunkText(block.text)) {
        push("content_block_delta", { index, delta: { type: "text_delta", text: chunk } });
      }
    } else {
      push("content_block_start", {
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      for (const chunk of chunkText(JSON.stringify(block.input), 12)) {
        push("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: chunk } });
      }
    }
    push("content_block_stop", { index });
  });

  push("message_delta", { delta: { stop_reason: reply.stopReason }, usage: { output_tokens: 48 } });
  push("message_stop", {});
  return out;
}

function chunkText(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}
