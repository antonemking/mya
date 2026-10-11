/**
 * Provider-neutral wire types.
 *
 * This package knows how to talk to one model provider. It does not know what a
 * tool does, where the transcript lives, or what the harness will do with the
 * result. Tools arrive here as a name and a JSON schema.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  /** Parsed arguments. The client parses the streamed JSON before it finishes. */
  arguments: unknown;
  /** Raw JSON the provider streamed, kept so a bad parse is still inspectable. */
  rawArguments: string;
}

/**
 * Provider state that has to come back on the next call unchanged, such as
 * encrypted reasoning. Only the provider named here reads it; every other
 * adapter, the loop, and the views skip it.
 */
export interface OpaqueBlock {
  type: "opaque";
  provider: string;
  data: unknown;
}

export type AssistantBlock = TextBlock | ToolCallBlock | OpaqueBlock;

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantBlock[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

/** A message the provider can read. Anything else must be dropped first. */
export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  /** Prefill served from the provider's cache. */
  cachedInputTokens: number;
  /** Prefill written into the provider's cache by this call. */
  cacheWriteTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "aborted" | "other";

export interface StreamRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Whether this call may write a prompt cache. Defaults to true. A one-off
   * call whose prefix will never repeat, such as a summary request, should
   * set false so it does not pay to cache a prefix nobody will read.
   */
  cache?: boolean;
  /**
   * A stable key for calls that share a prefix, such as a session id.
   * Providers that route caching by key use it; the rest ignore it.
   */
  cacheKey?: string;
  signal?: AbortSignal;
}

/** Streamed text. */
export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

/** A tool call is being streamed. `arguments` arrives as JSON fragments. */
export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  id: string;
  name: string;
  argumentsDelta: string;
}

/** A content block finished. */
export interface BlockDoneEvent {
  type: "block_done";
  index: number;
  block: AssistantBlock;
}

/** The whole assistant message finished. */
export interface MessageDoneEvent {
  type: "message_done";
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
}

/**
 * The exact JSON body sent to the provider. Headers stay out, so a credential
 * never lands in the event log.
 */
export interface RequestEvent {
  type: "request";
  body: string;
}

/** The exact response body, SSE or an error page, before it is parsed. */
export interface ResponseEvent {
  type: "response";
  status: number;
  body: string;
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolCallDeltaEvent
  | BlockDoneEvent
  | MessageDoneEvent
  | RequestEvent
  | ResponseEvent;

export interface ModelClient {
  readonly provider: string;
  readonly defaultModel: string;
  stream(request: StreamRequest): AsyncIterable<StreamEvent>;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
