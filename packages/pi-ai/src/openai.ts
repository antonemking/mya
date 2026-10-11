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

/**
 * The OpenAI chat completions wire format. Also speaks to anything that
 * copies it, by way of OPENAI_BASE_URL. The URL, the headers, the body, and
 * the key live in here; nothing outside this file knows them.
 */
export interface OpenAiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  organization?: string;
  /** Newer OpenAI models take max_completion_tokens; most clones take max_tokens. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  fetch?: typeof fetch;
}

export const DEFAULT_OPENAI_MODEL = "gpt-4.1";
const OPENAI_URL = "https://api.openai.com/v1";

export class OpenAiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

export class OpenAiClient implements ModelClient {
  readonly provider = "openai";
  readonly defaultModel: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly #organization: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new OpenAiError("OPENAI_API_KEY is not set");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? OPENAI_URL).replace(/\/$/, "");
    this.#maxTokens = options.maxTokens ?? 8192;
    this.#maxTokensField =
      options.maxTokensField ?? (this.#baseUrl.startsWith(OPENAI_URL) ? "max_completion_tokens" : "max_tokens");
    this.#organization = options.organization ?? process.env.OPENAI_ORG_ID;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.defaultModel = options.model || process.env.MYA_MODEL || process.env.PI_MODEL || DEFAULT_OPENAI_MODEL;
  }

  async *stream(request: StreamRequest): AsyncIterable<StreamEvent> {
    const body = JSON.stringify(buildChatBody(request, this.defaultModel, this.#maxTokens, this.#maxTokensField));
    yield { type: "request", body };

    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        accept: "text/event-stream",
        ...(this.#organization ? { "openai-organization": this.#organization } : {}),
      },
      body,
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "response", status: response.status, body: text };
      throw new OpenAiError(`openai request failed with ${response.status}`, response.status, text);
    }

    yield* decodeWithRaw(response.status, response.body, decodeChatStream);
  }
}

type AnyRecord = Record<string, unknown>;

interface PartialToolCall {
  block: number;
  id: string;
  name: string;
  json: string;
}

/** Exported for tests: chat completion SSE to provider-neutral events. */
export async function* decodeChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const toolCalls = new Map<number, PartialToolCall>();
  const usage: Usage = emptyUsage();
  let text = "";
  let textStarted = false;
  let nextBlock = 0;
  let stopReason: StopReason = "other";

  for await (const sse of readSse(body)) {
    if (sse.data === "[DONE]") break;
    let payload: AnyRecord;
    try {
      payload = JSON.parse(sse.data) as AnyRecord;
    } catch {
      continue;
    }

    const error = payload["error"] as AnyRecord | undefined;
    if (error) {
      throw new OpenAiError(typeof error["message"] === "string" ? (error["message"] as string) : "openai stream error");
    }

    mergeUsage(usage, payload["usage"] as AnyRecord | undefined);

    const choice = (payload["choices"] as AnyRecord[] | undefined)?.[0];
    if (!choice) continue;

    const finish = choice["finish_reason"];
    if (typeof finish === "string") stopReason = mapFinishReason(finish);

    const delta = choice["delta"] as AnyRecord | undefined;
    if (!delta) continue;

    const chunk = delta["content"];
    if (typeof chunk === "string" && chunk !== "") {
      if (!textStarted) {
        textStarted = true;
        nextBlock += 1;
      }
      text += chunk;
      yield { type: "text_delta", text: chunk };
    }

    for (const raw of (delta["tool_calls"] as AnyRecord[] | undefined) ?? []) {
      const index = numberOr(raw["index"], 0);
      const fn = (raw["function"] as AnyRecord | undefined) ?? {};
      let call = toolCalls.get(index);
      if (!call) {
        call = { block: nextBlock++, id: stringOr(raw["id"], `call_${index}`), name: stringOr(fn["name"], ""), json: "" };
        toolCalls.set(index, call);
      }
      if (typeof raw["id"] === "string" && raw["id"] !== "") call.id = raw["id"];
      if (typeof fn["name"] === "string" && fn["name"] !== "") call.name = fn["name"];

      const fragment = stringOr(fn["arguments"], "");
      if (fragment === "") continue;
      call.json += fragment;
      yield {
        type: "tool_call_delta",
        index: call.block,
        id: call.id,
        name: call.name,
        argumentsDelta: fragment,
      };
    }
  }

  const content: AssistantBlock[] = [];
  if (textStarted) {
    const block: AssistantBlock = { type: "text", text };
    content.push(block);
    yield { type: "block_done", index: 0, block };
  }
  for (const call of [...toolCalls.values()].sort((a, b) => a.block - b.block)) {
    const raw = call.json.trim() === "" ? "{}" : call.json;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const block: AssistantBlock = { type: "tool_call", id: call.id, name: call.name, arguments: parsed, rawArguments: raw };
    content.push(block);
    yield { type: "block_done", index: call.block, block };
  }

  const message: AssistantMessage = { role: "assistant", content };
  yield { type: "message_done", message, stopReason, usage };
}

export function buildChatBody(
  request: StreamRequest,
  defaultModel: string,
  defaultMaxTokens: number,
  maxTokensField: "max_tokens" | "max_completion_tokens" = "max_completion_tokens",
): AnyRecord {
  const body: AnyRecord = {
    model: request.model || defaultModel,
    messages: toOpenAiMessages(request.messages, request.system),
    stream: true,
    stream_options: { include_usage: true },
    [maxTokensField]: request.maxTokens ?? defaultMaxTokens,
  };
  if (request.tools && request.tools.length > 0) {
    body["tools"] = request.tools.map(toOpenAiTool);
  }
  if (request.temperature !== undefined) {
    body["temperature"] = request.temperature;
  }
  // There is no cache breakpoint here: this provider caches long prefixes on
  // its own, so `cache` needs nothing from us.
  return body;
}

function toOpenAiTool(tool: ToolSchema): AnyRecord {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Tool results are their own role here, so nothing has to be merged. */
export function toOpenAiMessages(messages: LlmMessage[], system?: string): AnyRecord[] {
  const out: AnyRecord[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content === "" ? "(no output)" : message.content,
      });
      continue;
    }

    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const calls = message.content
      .filter((block) => block.type === "tool_call")
      .map((block) => {
        const call = block as Extract<AssistantBlock, { type: "tool_call" }>;
        return {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: argumentsJson(call) },
        };
      });

    if (text === "" && calls.length === 0) continue;
    out.push({
      role: "assistant",
      content: text === "" ? null : text,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    });
  }
  return out;
}

function argumentsJson(call: Extract<AssistantBlock, { type: "tool_call" }>): string {
  if (call.rawArguments.trim() !== "") return call.rawArguments;
  try {
    return JSON.stringify(call.arguments ?? {});
  } catch {
    return "{}";
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

/**
 * prompt_tokens here counts cached tokens too. Subtracting keeps inputTokens
 * meaning the same thing it means for the other provider: fresh prefill.
 */
function mergeUsage(usage: Usage, raw: AnyRecord | undefined): void {
  if (!raw) return;
  const prompt = numberOr(raw["prompt_tokens"], 0);
  const details = raw["prompt_tokens_details"] as AnyRecord | undefined;
  const cached = numberOr(details?.["cached_tokens"], 0);
  usage.inputTokens += Math.max(0, prompt - cached);
  usage.cachedInputTokens += cached;
  usage.outputTokens += numberOr(raw["completion_tokens"], 0);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
