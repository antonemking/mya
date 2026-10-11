import type { LlmMessage, ModelClient, StopReason, ToolSchema, Usage } from "pi-ai";
import type { AgentEvent } from "./events.js";
import type { Session } from "./session.js";
import type { Tool, ToolCall, ToolContext, ToolResult } from "./tools/types.js";
import { defaultConvertToLlm, type Message } from "./transcript.js";

export interface TransformContextInput {
  messages: Message[];
  turn: number;
  cwd: string;
  model: string;
  /** The system prompt and tool schemas that go up with this call. Read-only. */
  system: string;
  tools: ToolSchema[];
  /**
   * The same client the loop uses. A hook that needs its own model call, such
   * as a summarizer, goes through this rather than reaching for a provider.
   */
  modelClient: ModelClient;
  session: Session;
  /**
   * Add a message to the transcript and the session file. A compaction policy
   * uses this to write its summary where resume and fork will find it.
   */
  append(message: Message): Promise<void>;
}

export interface BeforeToolCallInput {
  call: ToolCall;
  tool: Tool | undefined;
  turn: number;
  context: ToolContext;
}

export interface AfterTurnInput {
  turn: number;
  stopReason: StopReason;
  usage: Usage;
  messages: Message[];
  toolCalls: number;
}

/**
 * Extensions adapt the harness. They register tools, rewrite the context
 * before a call, refuse a tool call, and can stop the run after a turn.
 * Compaction is a `transformContext` hook, not a policy baked into the loop.
 */
export interface Extension {
  name: string;
  tools?: Tool[];
  /** Rewrite the transcript before each model call. Compaction lives here. */
  transformContext?(input: TransformContextInput): Message[] | Promise<Message[]>;
  /** Drop messages the provider cannot read. Last one registered wins. */
  convertToLlm?(messages: Message[]): LlmMessage[];
  /**
   * Called after the arguments are parsed and before the tool runs. Return a
   * result to refuse the call: the refusal text becomes the tool result, so
   * the next model call can see why it did not run.
   */
  beforeToolCall?(input: BeforeToolCallInput): ToolResult | undefined | Promise<ToolResult | undefined>;
  /** End the run after a normal turn. Does not cancel work already in flight. */
  shouldStopAfterTurn?(input: AfterTurnInput): boolean | Promise<boolean>;
  /** Watch the event stream without being a second loop. */
  onEvent?(event: AgentEvent): void;
}

export class ExtensionHost {
  readonly #extensions: Extension[] = [];
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Tool[] = [], extensions: Extension[] = []) {
    for (const tool of tools) this.#registerTool(tool, "core");
    for (const extension of extensions) this.register(extension);
  }

  register(extension: Extension): void {
    this.#extensions.push(extension);
    for (const tool of extension.tools ?? []) {
      this.#registerTool(tool, extension.name);
    }
  }

  get extensions(): readonly Extension[] {
    return this.#extensions;
  }

  tools(): Tool[] {
    return [...this.#tools.values()];
  }

  tool(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  async transformContext(input: TransformContextInput): Promise<Message[]> {
    let messages = input.messages;
    for (const extension of this.#extensions) {
      if (!extension.transformContext) continue;
      messages = await extension.transformContext({ ...input, messages });
    }
    return messages;
  }

  convertToLlm(messages: Message[]): LlmMessage[] {
    for (let i = this.#extensions.length - 1; i >= 0; i -= 1) {
      const convert = this.#extensions[i]?.convertToLlm;
      if (convert) return convert(messages);
    }
    return defaultConvertToLlm(messages);
  }

  async beforeToolCall(input: BeforeToolCallInput): Promise<{ result: ToolResult; by: string } | undefined> {
    for (const extension of this.#extensions) {
      if (!extension.beforeToolCall) continue;
      const result = await extension.beforeToolCall(input);
      if (result) return { result, by: extension.name };
    }
    return undefined;
  }

  async shouldStopAfterTurn(input: AfterTurnInput): Promise<boolean> {
    for (const extension of this.#extensions) {
      if (!extension.shouldStopAfterTurn) continue;
      if (await extension.shouldStopAfterTurn(input)) return true;
    }
    return false;
  }

  dispatch(event: AgentEvent): void {
    for (const extension of this.#extensions) {
      extension.onEvent?.(event);
    }
  }

  #registerTool(tool: Tool, owner: string): void {
    const existing = this.#tools.get(tool.name);
    if (existing && owner === "core") {
      throw new Error(`duplicate core tool: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }
}
