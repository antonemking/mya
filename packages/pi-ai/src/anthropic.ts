import { decodeWithRaw, readSse } from "./sse.js";
import {
  emptyUsage,
  type AssistantBlock,
  type AssistantMessage,
  type LlmMessage,
  type ModelClient,
  type StopReason,
  type StreamEvent,
  type StreamRequest,
  type ToolSchema,
  type Usage,
} from "./types.js";

export interface AnthropicClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  version?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

export class AnthropicClient implements ModelClient {
  readonly provider = "anthropic";
  readonly defaultModel: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #version: string;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AnthropicError("ANTHROPIC_API_KEY is not set");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#version = options.version ?? "2023-06-01";
    this.#maxTokens = options.maxTokens ?? 8192;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.defaultModel = options.model || process.env.MYA_MODEL || process.env.PI_MODEL || DEFAULT_ANTHROPIC_MODEL;
  }

  async *stream(request: StreamRequest): AsyncIterable<StreamEvent> {
    const body = JSON.stringify(buildBody(request, this.defaultModel, this.#maxTokens));
    yield { type: "request", body };

    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": this.#version,
        accept: "text/event-stream",
      },
      body,
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "response", status: response.status, body: text };
      throw new AnthropicError(`anthropic request failed with ${response.status}`, response.status, text);
    }

    yield* decodeWithRaw(response.status, response.body, decodeStream);
  }
}

/** Exported for tests: turns an Anthropic SSE body into provider-neutral events. */
export async function* decodeStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, PartialBlock>();
  const usage: Usage = emptyUsage();
  let stopReason: StopReason = "other";

  for await (const sse of readSse(body)) {
    if (sse.data === "[DONE]") break;
    let payload: AnyRecord;
    try {
      payload = JSON.parse(sse.data) as AnyRecord;
    } catch {
      continue;
    }
    const type = typeof payload["type"] === "string" ? (payload["type"] as string) : sse.event;

    switch (type) {
      case "message_start": {
        const message = payload["message"] as AnyRecord | undefined;
        mergeUsage(usage, message?.["usage"] as AnyRecord | undefined);
        break;
      }
      case "content_block_start": {
        const index = numberAt(payload, "index");
        const block = payload["content_block"] as AnyRecord | undefined;
        if (!block) break;
        if (block["type"] === "text") {
          blocks.set(index, { kind: "text", text: stringAt(block, "text") });
        } else if (block["type"] === "tool_use") {
          blocks.set(index, {
            kind: "tool_call",
            id: stringAt(block, "id"),
            name: stringAt(block, "name"),
            json: "",
          });
        } else {
          blocks.set(index, { kind: "ignored" });
        }
        break;
      }
      case "content_block_delta": {
        const index = numberAt(payload, "index");
        const delta = payload["delta"] as AnyRecord | undefined;
        const current = blocks.get(index);
        if (!delta || !current) break;
        if (delta["type"] === "text_delta" && current.kind === "text") {
          const text = stringAt(delta, "text");
          current.text += text;
          yield { type: "text_delta", text };
        } else if (delta["type"] === "input_json_delta" && current.kind === "tool_call") {
          const fragment = stringAt(delta, "partial_json");
          current.json += fragment;
          yield {
            type: "tool_call_delta",
            index,
            id: current.id,
            name: current.name,
            argumentsDelta: fragment,
          };
        }
        break;
      }
      case "content_block_stop": {
        const index = numberAt(payload, "index");
        const current = blocks.get(index);
        if (!current) break;
        const finished = finishBlock(current);
        if (finished) yield { type: "block_done", index, block: finished };
        break;
      }
      case "message_delta": {
        const delta = payload["delta"] as AnyRecord | undefined;
        const reason = delta?.["stop_reason"];
        if (typeof reason === "string") stopReason = mapStopReason(reason);
        mergeUsage(usage, payload["usage"] as AnyRecord | undefined);
        break;
      }
      case "message_stop": {
        break;
      }
      case "error": {
        const error = payload["error"] as AnyRecord | undefined;
        throw new AnthropicError(
          typeof error?.["message"] === "string" ? (error["message"] as string) : "anthropic stream error",
        );
      }
      default:
        break;
    }
  }

  const content: AssistantBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const finished = finishBlock(blocks.get(index)!);
    if (finished) content.push(finished);
  }
  const message: AssistantMessage = { role: "assistant", content };
  yield { type: "message_done", message, stopReason, usage };
}

type AnyRecord = Record<string, unknown>;

type PartialBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; json: string }
  | { kind: "ignored" };

function finishBlock(block: PartialBlock): AssistantBlock | undefined {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "tool_call") {
    const raw = block.json.trim() === "" ? "{}" : block.json;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    return { type: "tool_call", id: block.id, name: block.name, arguments: parsed, rawArguments: raw };
  }
  return undefined;
}

export function buildBody(request: StreamRequest, defaultModel: string, defaultMaxTokens: number): AnyRecord {
  const messages = toAnthropicMessages(request.messages);
  if (request.cache !== false) markCacheBreakpoint(messages);

  const body: AnyRecord = {
    model: request.model || defaultModel,
    max_tokens: request.maxTokens ?? defaultMaxTokens,
    stream: true,
    messages,
  };
  if (request.system) {
    body["system"] = [{ type: "text", text: request.system }];
  }
  if (request.tools && request.tools.length > 0) {
    body["tools"] = request.tools.map(toAnthropicTool);
  }
  if (request.temperature !== undefined) {
    body["temperature"] = request.temperature;
  }
  return body;
}

/**
 * One breakpoint, on the last block of the transcript. Everything before it
 * is the cacheable prefix: tools, system, and every earlier message. The next
 * call reads that prefix back, which is why this slice must not rewrite
 * earlier messages between turns.
 */
function markCacheBreakpoint(messages: AnyRecord[]): void {
  const last = messages.at(-1);
  if (!last) return;
  const content = last["content"];
  if (!Array.isArray(content) || content.length === 0) return;
  const block = content.at(-1) as AnyRecord | undefined;
  if (!block) return;
  block["cache_control"] = { type: "ephemeral" };
}

function toAnthropicTool(tool: ToolSchema): AnyRecord {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

/**
 * Anthropic carries tool results inside a user message, so consecutive tool
 * results collapse into one message. Everything else maps one to one.
 */
export function toAnthropicMessages(messages: LlmMessage[]): AnyRecord[] {
  const out: AnyRecord[] = [];
  let pendingToolResults: AnyRecord[] | undefined;

  const flush = () => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
    }
    pendingToolResults = undefined;
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingToolResults ??= [];
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content === "" ? "(no output)" : message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flush();
    if (message.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: message.content }] });
    } else {
      const content: AnyRecord[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text !== "") content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_call") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
        }
        // Opaque blocks belong to another provider.
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    }
  }
  flush();
  return out;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
      return reason;
    default:
      return "other";
  }
}

function mergeUsage(usage: Usage, raw: AnyRecord | undefined): void {
  if (!raw) return;
  usage.inputTokens += numberOr(raw["input_tokens"], 0);
  usage.cachedInputTokens += numberOr(raw["cache_read_input_tokens"], 0);
  usage.cacheWriteTokens += numberOr(raw["cache_creation_input_tokens"], 0);
  usage.outputTokens += numberOr(raw["output_tokens"], 0);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function numberAt(record: AnyRecord, key: string): number {
  return numberOr(record[key], 0);
}

function stringAt(record: AnyRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
