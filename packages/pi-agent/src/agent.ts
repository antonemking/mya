import {
  addUsage,
  emptyUsage,
  type AssistantMessage,
  type ModelClient,
  type StopReason,
  type ToolCallBlock,
  type ToolSchema,
  type Usage,
} from "pi-ai";
import {
  EventBus,
  type AgentEndReason,
  type AgentEvent,
  type AgentEventListener,
} from "./events.js";
import { ExtensionHost, type Extension } from "./extensions.js";
import { defaultSystemPrompt } from "./prompt.js";
import { eventsFileFor, JsonlEventLog, NullSession, type Session } from "./session.js";
import { coreTools } from "./tools/index.js";
import type { Tool, ToolCall, ToolContext, ToolOutcome } from "./tools/types.js";
import { userMessage, type Message } from "./transcript.js";

export interface AgentOptions {
  model: ModelClient;
  /** Model id. Defaults to the client's default model. */
  modelName?: string;
  cwd?: string;
  system?: string;
  /**
   * A transcript to start from, as loaded from a session file. These are
   * already on disk, so they are not appended to the session again.
   */
  messages?: Message[];
  /** Defaults to the four core tools. */
  tools?: Tool[];
  extensions?: Extension[];
  session?: Session;
  maxTurns?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  reason: AgentEndReason;
  turns: number;
  usage: Usage;
  messages: Message[];
  error?: Error;
}

/**
 * One turn is one model call plus the tool calls that came back with it.
 * If there are tool results, call the model again. If the model answers in
 * text, stop, unless a follow-up was queued.
 */
export class Agent {
  readonly cwd: string;
  readonly model: ModelClient;
  readonly modelName: string;
  readonly session: Session;
  readonly host: ExtensionHost;

  readonly #bus = new EventBus();
  readonly #messages: Message[] = [];
  readonly #steering: string[] = [];
  readonly #followUps: string[] = [];
  readonly #maxTurns: number;
  readonly #maxTokens: number | undefined;
  readonly #system: string | undefined;
  readonly #externalSignal: AbortSignal | undefined;

  #controller = new AbortController();
  #turn = 0;
  #running = false;
  readonly #events: JsonlEventLog | undefined;

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.modelName = options.modelName ?? options.model.defaultModel;
    this.cwd = options.cwd ?? process.cwd();
    this.session = options.session ?? new NullSession();
    this.host = new ExtensionHost(options.tools ?? coreTools(), options.extensions ?? []);
    this.#maxTurns = options.maxTurns ?? 30;
    this.#maxTokens = options.maxTokens;
    this.#system = options.system;
    this.#externalSignal = options.signal;
    if (options.messages) this.#messages.push(...options.messages);
    this.#bus.subscribe((event) => this.host.dispatch(event));
    this.#events = this.session.file ? new JsonlEventLog(eventsFileFor(this.session.file)) : undefined;
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.#bus.subscribe(listener);
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  get turn(): number {
    return this.#turn;
  }

  /**
   * A correction of the turn in progress. It is inserted after the tool that
   * is running now. Tools still waiting in that batch do not run.
   */
  steer(text: string): void {
    this.#steering.push(text);
  }

  /** Waits until the model would otherwise stop, then starts another turn. */
  followUp(text: string): void {
    this.#followUps.push(text);
  }

  abort(): void {
    this.#controller.abort();
  }

  async run(prompt?: string): Promise<AgentResult> {
    if (this.#running) throw new Error("agent is already running");
    this.#running = true;
    this.#controller = new AbortController();
    const onExternalAbort = () => this.#controller.abort();
    this.#externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const tools = this.host.tools();
    const system = this.#system ?? defaultSystemPrompt({ cwd: this.cwd, toolNames: tools.map((t) => t.name) });
    const schemas: ToolSchema[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    this.#emit({
      type: "agent_start",
      sessionId: this.session.id,
      cwd: this.cwd,
      model: this.modelName,
      provider: this.model.provider,
      ...(this.session.file ? { sessionFile: this.session.file } : {}),
      at: Date.now(),
    });

    let usage = emptyUsage();
    let reason: AgentEndReason = "end_turn";
    let error: Error | undefined;
    // Turn numbers keep climbing across a session; the budget is per run.
    const firstTurn = this.#turn;

    try {
      if (prompt !== undefined) await this.#append(userMessage(prompt));

      while (true) {
        if (this.#controller.signal.aborted) {
          reason = "aborted";
          break;
        }
        if (this.#turn - firstTurn >= this.#maxTurns) {
          reason = "max_turns";
          break;
        }

        const turn = ++this.#turn;
        this.#emit({ type: "turn_start", turn, at: Date.now() });

        const context = await this.host.transformContext({
          messages: [...this.#messages],
          turn,
          cwd: this.cwd,
          model: this.modelName,
          system,
          tools: schemas,
          modelClient: this.model,
          session: this.session,
          append: (message) => this.#append(message),
        });
        const llmMessages = this.host.convertToLlm(context);
        this.#emit({
          type: "context_snapshot",
          turn,
          model: this.modelName,
          system,
          tools: schemas,
          messages: llmMessages,
          at: Date.now(),
        });

        const turnResult = await this.#streamTurn(turn, system, llmMessages, schemas);
        usage = addUsage(usage, turnResult.usage);
        await this.#append(turnResult.message);

        const toolCalls = turnResult.message.content.filter(
          (block): block is ToolCallBlock => block.type === "tool_call",
        );

        let everyResultTerminates = toolCalls.length > 0;
        const skipped: Array<{ id: string; name: string }> = [];
        for (let index = 0; index < toolCalls.length; index += 1) {
          const block = toolCalls[index]!;
          if (this.#steering.length > 0) {
            for (const pending of toolCalls.slice(index)) {
              await this.#skipTool(turn, pending);
              skipped.push({ id: pending.id, name: pending.name });
            }
            everyResultTerminates = false;
            break;
          }
          const outcome = await this.#runTool(turn, block);
          if (!outcome.terminate) everyResultTerminates = false;
        }

        // The steer sits after the tool that just finished, before the turn closes,
        // so a replay can show the insertion before the next model call.
        await this.#drainSteering(turn, skipped);

        this.#emit({
          type: "turn_end",
          turn,
          message: turnResult.message,
          stopReason: turnResult.stopReason,
          usage: turnResult.usage,
          toolCalls: toolCalls.length,
          at: Date.now(),
        });

        const stopAfterTurn = await this.host.shouldStopAfterTurn({
          turn,
          stopReason: turnResult.stopReason,
          usage: turnResult.usage,
          messages: [...this.#messages],
          toolCalls: toolCalls.length,
        });
        if (stopAfterTurn) {
          reason = "stopped";
          break;
        }

        if (toolCalls.length > 0 && !everyResultTerminates) continue;

        // The model would otherwise stop here.
        if (this.#followUps.length > 0) {
          await this.#drain(this.#followUps);
          continue;
        }

        reason = everyResultTerminates ? "terminated" : "end_turn";
        break;
      }
    } catch (caught) {
      if (this.#controller.signal.aborted) {
        reason = "aborted";
      } else {
        reason = "error";
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
    } finally {
      this.#externalSignal?.removeEventListener("abort", onExternalAbort);
      this.#running = false;
    }

    const turns = this.#turn - firstTurn;
    this.#emit({
      type: "agent_end",
      reason,
      turns,
      usage,
      ...(error ? { error: error.message } : {}),
      at: Date.now(),
    });
    await this.#events?.flush();

    return { reason, turns, usage, messages: [...this.#messages], ...(error ? { error } : {}) };
  }

  async #streamTurn(
    turn: number,
    system: string,
    llmMessages: ReturnType<ExtensionHost["convertToLlm"]>,
    tools: ToolSchema[],
  ): Promise<{ message: AssistantMessage; stopReason: StopReason; usage: Usage }> {
    let message: AssistantMessage | undefined;
    let stopReason: StopReason = "other";
    let usage = emptyUsage();

    const stream = this.model.stream({
      model: this.modelName,
      system,
      messages: llmMessages,
      tools,
      ...(this.#maxTokens === undefined ? {} : { maxTokens: this.#maxTokens }),
      cacheKey: this.session.id,
      signal: this.#controller.signal,
    });

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          this.#emit({ type: "message_update", turn, delta: { kind: "text", text: event.text } });
          break;
        case "tool_call_delta":
          this.#emit({
            type: "message_update",
            turn,
            delta: {
              kind: "tool_call",
              index: event.index,
              id: event.id,
              name: event.name,
              argumentsDelta: event.argumentsDelta,
            },
          });
          break;
        case "request":
          this.#emit({ type: "model_request", turn, body: event.body, at: Date.now() });
          break;
        case "response":
          this.#emit({ type: "model_response", turn, status: event.status, body: event.body, at: Date.now() });
          break;
        case "message_done":
          message = event.message;
          stopReason = event.stopReason;
          usage = event.usage;
          break;
        default:
          break;
      }
    }

    if (!message) throw new Error("provider stream ended without a message");
    return { message, stopReason, usage };
  }

  async #runTool(turn: number, block: ToolCallBlock): Promise<ToolOutcome> {
    const call: ToolCall = {
      id: block.id,
      name: block.name,
      arguments: block.arguments,
      rawArguments: block.rawArguments,
    };
    const context: ToolContext = {
      cwd: this.cwd,
      signal: this.#controller.signal,
      toolCallId: call.id,
      turn,
    };

    this.#emit({ type: "tool_execution_start", turn, call, at: Date.now() });
    const startedAt = Date.now();

    const tool = this.host.tool(call.name);
    let outcome: ToolOutcome;

    const refusal = await this.host.beforeToolCall({ call, tool, turn, context });
    if (refusal) {
      outcome = { ...refusal.result, refusedBy: refusal.by };
    } else if (!tool) {
      outcome = {
        output: `unknown tool: ${call.name}. Available tools: ${this.host
          .tools()
          .map((t) => t.name)
          .join(", ")}`,
        isError: true,
      };
    } else if (call.arguments === undefined || typeof call.arguments !== "object" || call.arguments === null) {
      outcome = {
        output: `could not parse arguments for ${call.name} as a JSON object: ${call.rawArguments}`,
        isError: true,
      };
    } else {
      try {
        outcome = await tool.execute(call.arguments, context);
      } catch (caught) {
        outcome = { output: `${call.name} failed: ${(caught as Error).message}`, isError: true };
      }
    }

    this.#emit({
      type: "tool_execution_end",
      turn,
      call,
      outcome,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    });

    if (outcome.check) {
      const { command, passed, output, score } = outcome.check;
      this.#emit({
        type: "check",
        turn,
        command,
        passed,
        output,
        ...(score === undefined ? {} : { score }),
        at: Date.now(),
      });
    }

    // A refused call is still a tool result, so the next model call sees why.
    await this.#append({
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: outcome.output,
      ...(outcome.isError ? { isError: true } : {}),
    });

    return outcome;
  }

  /** The model asked for this call. A steer arrived, so it does not run. */
  async #skipTool(turn: number, block: ToolCallBlock): Promise<void> {
    const call: ToolCall = {
      id: block.id,
      name: block.name,
      arguments: block.arguments,
      rawArguments: block.rawArguments,
    };
    const outcome: ToolOutcome = {
      output: "not run: a steering message arrived before this tool",
      isError: true,
    };
    this.#emit({ type: "tool_execution_start", turn, call, at: Date.now() });
    this.#emit({
      type: "tool_execution_end",
      turn,
      call,
      outcome,
      durationMs: 0,
      at: Date.now(),
    });
    await this.#append({
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: outcome.output,
      isError: true,
    });
  }

  async #drainSteering(turn: number, skipped: Array<{ id: string; name: string }>): Promise<void> {
    let first = true;
    while (this.#steering.length > 0) {
      const text = this.#steering.shift();
      if (text === undefined) break;
      this.#emit({
        type: "steer",
        turn,
        text,
        skipped: first ? skipped : [],
        at: Date.now(),
      });
      first = false;
      await this.#append(userMessage(text));
    }
  }

  async #drain(queue: string[]): Promise<void> {
    while (queue.length > 0) {
      const text = queue.shift();
      if (text === undefined) break;
      await this.#append(userMessage(text));
    }
  }

  async #append(message: Message): Promise<void> {
    this.#messages.push(message);
    await this.session.append(message);
  }

  #emit(event: AgentEvent): void {
    this.#bus.emit(event);
    void this.#events?.append(event);
  }
}
