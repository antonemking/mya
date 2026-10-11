import type { AssistantMessage, LlmMessage, StopReason, ToolSchema, Usage } from "pi-ai";
import type { CheckReport, ToolCall, ToolOutcome } from "./tools/types.js";

/**
 * The harness speaks events. Print mode, JSON mode, and any later TUI are
 * subscribers to this stream. None of them is a second loop.
 */

export interface AgentStartEvent {
  type: "agent_start";
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  sessionFile?: string;
  at: number;
}

export interface TurnStartEvent {
  type: "turn_start";
  turn: number;
  at: number;
}

export type MessageDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; index: number; id: string; name: string; argumentsDelta: string };

export interface MessageUpdateEvent {
  type: "message_update";
  turn: number;
  delta: MessageDelta;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  turn: number;
  call: ToolCall;
  at: number;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  turn: number;
  call: ToolCall;
  outcome: ToolOutcome;
  durationMs: number;
  at: number;
}

/**
 * What one model call will send, after transformContext and convertToLlm.
 * The raw provider body stays on model_request.
 */
export interface ContextSnapshotEvent {
  type: "context_snapshot";
  turn: number;
  model: string;
  system: string;
  tools: ToolSchema[];
  messages: LlmMessage[];
  at: number;
}

/** The JSON body of one model call. No headers. */
export interface ModelRequestEvent {
  type: "model_request";
  turn: number;
  body: string;
  at: number;
}

/** The raw response body of that call, kept so a later replay can show the wire. */
export interface ModelResponseEvent {
  type: "model_response";
  turn: number;
  status: number;
  body: string;
  at: number;
}

/** A correction inserted after the tool that was running. Remaining calls in that batch did not run. */
export interface SteerEvent {
  type: "steer";
  turn: number;
  text: string;
  skipped: Array<{ id: string; name: string }>;
  at: number;
}

/** A check tool finished. The loop does not store this or read the score. */
export interface CheckEvent extends CheckReport {
  type: "check";
  turn: number;
  at: number;
}

export interface TurnEndEvent {
  type: "turn_end";
  turn: number;
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
  toolCalls: number;
  at: number;
}

export type AgentEndReason = "end_turn" | "terminated" | "max_turns" | "stopped" | "aborted" | "error";

export interface AgentEndEvent {
  type: "agent_end";
  reason: AgentEndReason;
  turns: number;
  usage: Usage;
  error?: string;
  at: number;
}

export type AgentEvent =
  | AgentStartEvent
  | TurnStartEvent
  | MessageUpdateEvent
  | ContextSnapshotEvent
  | ModelRequestEvent
  | ModelResponseEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | SteerEvent
  | CheckEvent
  | TurnEndEvent
  | AgentEndEvent;

export type AgentEventListener = (event: AgentEvent) => void;

export class EventBus {
  #listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}
