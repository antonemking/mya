import { codexOriginator, refreshOpenAiCodex } from "./auth/openai-codex.js";
import { CredentialStore, type OAuthCredential } from "./auth/store.js";
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
 * A ChatGPT subscription through the Codex backend. It speaks the Responses
 * wire format, statelessly (`store: false`), so the whole transcript goes up
 * on every call and encrypted reasoning rides along in an opaque block.
 */
export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type TextVerbosity = "low" | "medium" | "high";

export interface OpenAiCodexClientOptions {
  store?: CredentialStore;
  baseUrl?: string;
  authBaseUrl?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  verbosity?: TextVerbosity;
  fetch?: typeof fetch;
}

export class CodexError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CodexError";
  }
}

export class OpenAiCodexClient implements ModelClient {
  readonly provider = CODEX_PROVIDER;
  readonly defaultModel: string;

  readonly #store: CredentialStore;
  readonly #baseUrl: string;
  readonly #authBaseUrl: string | undefined;
  readonly #effort: ReasoningEffort;
  readonly #verbosity: TextVerbosity;
  readonly #fetch: typeof fetch;
  #credential: OAuthCredential;

  constructor(options: OpenAiCodexClientOptions = {}) {
    this.#store = options.store ?? new CredentialStore();
    const credential = this.#store.get(CODEX_PROVIDER);
    if (!credential) {
      throw new CodexError(`not logged in to ${CODEX_PROVIDER}. Run \`mya login ${CODEX_PROVIDER}\` first.`);
    }
    this.#credential = credential;
    this.#baseUrl = (options.baseUrl ?? process.env.MYA_CODEX_BASE_URL ?? DEFAULT_CODEX_BASE_URL).replace(/\/$/, "");
    this.#authBaseUrl = options.authBaseUrl;
    this.#effort = options.reasoningEffort ?? (process.env.MYA_REASONING_EFFORT as ReasoningEffort | undefined) ?? "medium";
    this.#verbosity = options.verbosity ?? (process.env.MYA_TEXT_VERBOSITY as TextVerbosity | undefined) ?? "medium";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.defaultModel = options.model || process.env.MYA_MODEL || process.env.PI_MODEL || DEFAULT_CODEX_MODEL;
  }

  async *stream(request: StreamRequest): AsyncIterable<StreamEvent> {
    const body = JSON.stringify(
      buildCodexBody(request, this.defaultModel, { effort: this.#effort, verbosity: this.#verbosity }),
    );
    yield { type: "request", body };

    let credential = await this.#fresh(request.signal, false);
    let response = await this.#post(body, credential, request);
    if (response.status === 401) {
      // The token can be revoked or rotated early; one refresh, then give up.
      credential = await this.#fresh(request.signal, true);
      response = await this.#post(body, credential, request);
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "response", status: response.status, body: text };
      throw new CodexError(describeFailure(response.status, text), response.status);
    }
    yield* decodeWithRaw(response.status, response.body, decodeCodexStream);
  }

  #post(body: string, credential: OAuthCredential, request: StreamRequest): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": credential.accountId ?? "",
      originator: codexOriginator(),
      "user-agent": "mya/0.1.0",
      "openai-beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    if (request.cacheKey) {
      headers["session-id"] = request.cacheKey;
      headers["x-client-request-id"] = request.cacheKey;
    }
    return this.#fetch(`${this.#baseUrl}/codex/responses`, {
      method: "POST",
      headers,
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  async #fresh(signal: AbortSignal | undefined, force: boolean): Promise<OAuthCredential> {
    // Another process may have refreshed since we loaded; prefer the newest.
    const stored = this.#store.get(CODEX_PROVIDER);
    if (stored && stored.expires > this.#credential.expires) this.#credential = stored;

    if (!force && this.#credential.expires - Date.now() > REFRESH_MARGIN_MS) return this.#credential;

    const refreshed = await refreshOpenAiCodex(this.#credential, {
      ...(this.#authBaseUrl ? { authBaseUrl: this.#authBaseUrl } : {}),
      fetch: this.#fetch,
      ...(signal ? { signal } : {}),
    }).catch((error: Error) => {
      throw new CodexError(`${error.message}. Run \`mya login ${CODEX_PROVIDER}\` again.`);
    });
    this.#credential = { ...refreshed, ...(this.#credential.email && !refreshed.email ? { email: this.#credential.email } : {}) };
    this.#store.set(CODEX_PROVIDER, this.#credential);
    return this.#credential;
  }
}

type AnyRecord = Record<string, unknown>;

export function buildCodexBody(
  request: StreamRequest,
  defaultModel: string,
  settings: { effort: ReasoningEffort; verbosity: TextVerbosity },
): AnyRecord {
  const body: AnyRecord = {
    model: request.model || defaultModel,
    store: false,
    stream: true,
    instructions: request.system || "You are a helpful assistant.",
    input: toCodexInput(request.messages),
    text: { verbosity: settings.verbosity },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: settings.effort, summary: "auto" },
  };
  if (request.cacheKey) body["prompt_cache_key"] = request.cacheKey;
  if (request.tools && request.tools.length > 0) body["tools"] = request.tools.map(toCodexTool);
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  // `cache: false` needs nothing here: this backend caches by prefix and key.
  return body;
}

function toCodexTool(tool: ToolSchema): AnyRecord {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

/**
 * An assistant message this provider produced carries its raw output items in
 * an opaque block, and those go back verbatim so reasoning stays paired with
 * the calls it led to. Messages from any other provider are rebuilt from the
 * neutral blocks.
 */
export function toCodexInput(messages: LlmMessage[]): AnyRecord[] {
  const input: AnyRecord[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content === "" ? "(no output)" : message.content,
      });
      continue;
    }

    const own = message.content.find(
      (block): block is Extract<AssistantBlock, { type: "opaque" }> =>
        block.type === "opaque" && block.provider === CODEX_PROVIDER,
    );
    const items = (own?.data as { items?: AnyRecord[] } | undefined)?.items;
    if (items && items.length > 0) {
      input.push(...items);
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text !== "") {
        input.push({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        });
      } else if (block.type === "tool_call") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: block.rawArguments.trim() === "" ? JSON.stringify(block.arguments ?? {}) : block.rawArguments,
        });
      }
    }
  }
  return input;
}

type Slot =
  | { kind: "message"; block: number; text: string }
  | { kind: "function_call"; block: number; callId: string; name: string; args: string }
  | { kind: "other" };

/** Exported for tests: Responses SSE to provider-neutral events. */
export async function* decodeCodexStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const slots = new Map<number, Slot>();
  const rawItems = new Map<number, AnyRecord>();
  const usage: Usage = emptyUsage();
  let nextBlock = 0;
  let status = "completed";
  let incompleteReason: string | undefined;

  const messageSlot = (index: number): Extract<Slot, { kind: "message" }> => {
    const existing = slots.get(index);
    if (existing?.kind === "message") return existing;
    const slot = { kind: "message" as const, block: nextBlock++, text: "" };
    slots.set(index, slot);
    return slot;
  };

  for await (const sse of readSse(body)) {
    if (sse.data === "[DONE]") break;
    let event: AnyRecord;
    try {
      event = JSON.parse(sse.data) as AnyRecord;
    } catch {
      continue;
    }
    const type = typeof event["type"] === "string" ? (event["type"] as string) : sse.event;
    const index = typeof event["output_index"] === "number" ? (event["output_index"] as number) : 0;

    switch (type) {
      case "response.output_item.added": {
        const item = (event["item"] as AnyRecord | undefined) ?? {};
        if (item["type"] === "message") {
          messageSlot(index);
        } else if (item["type"] === "function_call") {
          slots.set(index, {
            kind: "function_call",
            block: nextBlock++,
            callId: String(item["call_id"] ?? item["id"] ?? `call_${index}`),
            name: String(item["name"] ?? ""),
            args: typeof item["arguments"] === "string" ? (item["arguments"] as string) : "",
          });
        } else if (!slots.has(index)) {
          slots.set(index, { kind: "other" });
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = typeof event["delta"] === "string" ? (event["delta"] as string) : "";
        if (delta === "") break;
        const slot = messageSlot(index);
        slot.text += delta;
        yield { type: "text_delta", text: delta };
        break;
      }
      case "response.function_call_arguments.delta": {
        const slot = slots.get(index);
        const delta = typeof event["delta"] === "string" ? (event["delta"] as string) : "";
        if (slot?.kind !== "function_call" || delta === "") break;
        slot.args += delta;
        yield { type: "tool_call_delta", index: slot.block, id: slot.callId, name: slot.name, argumentsDelta: delta };
        break;
      }
      case "response.output_item.done": {
        const item = (event["item"] as AnyRecord | undefined) ?? {};
        rawItems.set(index, item);
        const slot = slots.get(index);
        if (item["type"] === "message") {
          const text = ((item["content"] as AnyRecord[] | undefined) ?? [])
            .filter((part) => part["type"] === "output_text")
            .map((part) => String(part["text"] ?? ""))
            .join("");
          const target = slot?.kind === "message" ? slot : messageSlot(index);
          if (text !== "") target.text = text;
        } else if (item["type"] === "function_call" && slot?.kind === "function_call") {
          if (typeof item["arguments"] === "string") slot.args = item["arguments"] as string;
          if (typeof item["call_id"] === "string") slot.callId = item["call_id"] as string;
        }
        break;
      }
      case "response.completed":
      case "response.done":
      case "response.incomplete": {
        const response = (event["response"] as AnyRecord | undefined) ?? {};
        status = String(response["status"] ?? (type === "response.incomplete" ? "incomplete" : "completed"));
        const details = response["incomplete_details"] as AnyRecord | undefined;
        if (typeof details?.["reason"] === "string") incompleteReason = details["reason"] as string;
        mergeUsage(usage, response["usage"] as AnyRecord | undefined);
        break;
      }
      case "response.failed": {
        const response = (event["response"] as AnyRecord | undefined) ?? {};
        const error = response["error"] as AnyRecord | undefined;
        throw new CodexError(String(error?.["message"] ?? "the codex response failed"));
      }
      case "error": {
        const nested = event["error"] as AnyRecord | undefined;
        throw new CodexError(String(event["message"] ?? nested?.["message"] ?? "codex stream error"));
      }
      default:
        break;
    }
  }

  const content: AssistantBlock[] = [];
  let sawCall = false;
  for (const index of [...slots.keys()].sort((a, b) => a - b)) {
    const slot = slots.get(index)!;
    if (slot.kind === "message" && slot.text !== "") {
      content.push({ type: "text", text: slot.text });
    } else if (slot.kind === "function_call") {
      sawCall = true;
      const raw = slot.args.trim() === "" ? "{}" : slot.args;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      content.push({ type: "tool_call", id: slot.callId, name: slot.name, arguments: parsed, rawArguments: raw });
    }
  }
  if (rawItems.size > 0) {
    const items = [...rawItems.keys()].sort((a, b) => a - b).map((index) => rawItems.get(index)!);
    content.push({ type: "opaque", provider: CODEX_PROVIDER, data: { items } });
  }

  const stopReason: StopReason = sawCall
    ? "tool_use"
    : status === "incomplete" && incompleteReason === "max_output_tokens"
      ? "max_tokens"
      : "end_turn";
  const message: AssistantMessage = { role: "assistant", content };
  yield { type: "message_done", message, stopReason, usage };
}

/** input_tokens counts cached tokens too; inputTokens stays fresh prefill. */
function mergeUsage(usage: Usage, raw: AnyRecord | undefined): void {
  if (!raw) return;
  const input = typeof raw["input_tokens"] === "number" ? (raw["input_tokens"] as number) : 0;
  const details = raw["input_tokens_details"] as AnyRecord | undefined;
  const cached = typeof details?.["cached_tokens"] === "number" ? (details["cached_tokens"] as number) : 0;
  usage.inputTokens += Math.max(0, input - cached);
  usage.cachedInputTokens += cached;
  usage.outputTokens += typeof raw["output_tokens"] === "number" ? (raw["output_tokens"] as number) : 0;
}

function describeFailure(status: number, text: string): string {
  let detail = text;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string };
    detail =
      (typeof json.error === "object" ? json.error?.message : json.error) ?? json.detail ?? json.message ?? text;
  } catch {
    // Not JSON; keep the text.
  }
  if (status === 429) return `codex usage limit reached (429): ${detail}`;
  if (status === 401 || status === 403) {
    return `codex rejected the login (${status}): ${detail}. Run \`mya login ${CODEX_PROVIDER}\` again.`;
  }
  return `codex request failed (${status}): ${detail}`;
}
