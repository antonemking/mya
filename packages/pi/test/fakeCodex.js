import { createServer } from "node:http";

/**
 * A test fixture, not a provider. It speaks the Codex backend's Responses SSE
 * so the real codex client, loop, tools, and views all run. The first call
 * reasons and asks to read README.md; the second summarizes the tool output.
 */
export function startFakeCodex() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      requests.push({ url: req.url, headers: req.headers, body: request });

      if (!String(req.headers.authorization ?? "").startsWith("Bearer ") || !req.headers["chatgpt-account-id"]) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "missing auth" }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const output = request.input.find((item) => item.type === "function_call_output");
      for (const event of output ? answer(output.output, requests.length) : toolCall(requests.length)) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const usage = (call) => ({
  input_tokens: 1500 * call,
  input_tokens_details: { cached_tokens: call > 1 ? 1200 : 0 },
  output_tokens: 60,
});

function toolCall(call) {
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "ENCRYPTED-REASONING" };
  const fc = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: '{"path":"README.md"}', status: "completed" };
  return [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_fixture" } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...fc, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '"README.md"}' },
    { type: "response.output_item.done", output_index: 1, item: fc },
    { type: "response.completed", response: { status: "completed", usage: usage(call) } },
  ];
}

function answer(toolOutput, call) {
  const heading = /#\s+(.+)/.exec(toolOutput)?.[1] ?? "the file";
  const text = `The README is titled "${heading}" and runs ${toolOutput.split("\n").length} lines.`;
  const events = [{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture" } }];
  for (let i = 0; i < text.length; i += 16) {
    events.push({ type: "response.output_text.delta", output_index: 0, delta: text.slice(i, i + 16) });
  }
  events.push(
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text }] },
    },
    { type: "response.completed", response: { status: "completed", usage: usage(call) } },
  );
  return events;
}
