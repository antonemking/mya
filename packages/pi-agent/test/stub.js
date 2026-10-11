/** A scripted model client. Each script entry is one model call. */
export class StubModel {
  constructor(script) {
    this.provider = "stub";
    this.defaultModel = "stub-1";
    this.script = [...script];
    this.calls = [];
  }

  async *stream(request) {
    this.calls.push(request);
    const step = this.script.shift();
    if (!step) throw new Error("stub model ran out of script");

    const content = [];
    for (const block of typeof step === "function" ? step(request) : step) {
      if (block.text !== undefined) {
        yield { type: "text_delta", text: block.text };
        content.push({ type: "text", text: block.text });
      } else {
        const raw = JSON.stringify(block.arguments ?? {});
        yield {
          type: "tool_call_delta",
          index: content.length,
          id: block.id,
          name: block.name,
          argumentsDelta: raw,
        };
        content.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: block.arguments ?? {},
          rawArguments: raw,
        });
      }
    }

    yield {
      type: "message_done",
      message: { role: "assistant", content },
      stopReason: content.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    };
  }
}

export function recordEvents(agent) {
  const events = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

export const types = (events) => events.map((e) => e.type);
