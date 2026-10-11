import type { AssistantMessage, LlmMessage, ToolResultMessage, UserMessage } from "pi-ai";

/**
 * A message the provider cannot read. An extension can park state in the
 * transcript and drop it again in `convertToLlm`.
 */
export interface CustomMessage {
  role: "custom";
  kind: string;
  payload: unknown;
}

export type Message = LlmMessage | CustomMessage;

export type { AssistantMessage, LlmMessage, ToolResultMessage, UserMessage };

export function isLlmMessage(message: Message): message is LlmMessage {
  return message.role !== "custom";
}

/** Default conversion: keep everything the provider can read, drop the rest. */
export function defaultConvertToLlm(messages: Message[]): LlmMessage[] {
  return messages.filter(isLlmMessage);
}

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

export function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}
