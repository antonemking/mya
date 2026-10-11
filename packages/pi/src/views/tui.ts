import { emitKeypressEvents, type Key } from "node:readline";
import * as readline from "node:readline/promises";
import type { Agent, AgentEvent } from "pi-agent";
import { palette, toolLine, toolResultLine, usageLine } from "./format.js";

/** A spinner the renderer can raise while it waits for the next event. */
export interface Status {
  start(label: string): void;
  stop(): void;
}

export interface TuiRendererOptions {
  write: (text: string) => void;
  color?: boolean;
  status?: Status;
}

/**
 * The TUI renders a turn exactly the way print mode does, and adds chrome
 * around it. It is a third subscriber to the events the loop already emits.
 */
export function tuiRenderer({ write, color = false, status }: TuiRendererOptions): (event: AgentEvent) => void {
  const { dim, bold } = palette(color);
  let textThisTurn = false;

  return (event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        // The banner is printed once when the session opens.
        break;

      case "turn_start":
        textThisTurn = false;
        write("\n" + bold(`turn ${event.turn}`) + "\n");
        status?.start("thinking");
        break;

      case "message_update":
        if (event.delta.kind === "text") {
          if (!textThisTurn) {
            status?.stop();
            textThisTurn = true;
            write("  ");
          }
          write(event.delta.text.replace(/\n/g, "\n  "));
        }
        break;

      case "context_snapshot":
        write(dim(`  context · ${event.messages.length} messages · ${event.tools.length} tools`) + "\n");
        break;

      case "model_request":
        write(dim(`  request · ${event.body.length} chars`) + "\n");
        break;

      case "model_response":
        status?.stop();
        write(dim(`  response ${event.status} · ${event.body.length} chars`) + "\n");
        break;

      case "tool_execution_start":
        status?.stop();
        if (textThisTurn) write("\n");
        textThisTurn = false;
        write(`  ${toolLine(event.call.name, event.call.arguments, event.call.rawArguments)}\n`);
        status?.start(event.call.name);
        break;

      case "tool_execution_end":
        status?.stop();
        write(dim(`    ${toolResultLine(event.outcome, event.durationMs)}`) + "\n");
        break;

      case "steer":
        write(dim(`  steer · ${event.text}`) + "\n");
        break;

      case "check":
        write(
          dim(
            `  check ${event.passed ? "pass" : "fail"} · ${event.command}${event.score === undefined ? "" : ` · score ${event.score}`}`,
          ) + "\n",
        );
        break;

      case "turn_end":
        status?.stop();
        if (textThisTurn) write("\n");
        write(dim(`  ${event.stopReason} · ${usageLine(event.usage)}`) + "\n");
        break;

      case "agent_end":
        status?.stop();
        write(
          dim(`  ${event.reason} · ${event.turns} turn${event.turns === 1 ? "" : "s"} · ${usageLine(event.usage)}`) +
            "\n",
        );
        if (event.error) write(`  error: ${event.error}\n`);
        break;

      default:
        break;
    }
  };
}

export interface TuiOptions {
  agent: Agent;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  color?: boolean;
}

const HELP = [
  "  /help      show this",
  "  /tools     list the tools the model can call",
  "  /session   show the session file",
  "  /clear     clear the screen",
  "  /exit      leave",
].join("\n");

/**
 * Reads a line, runs one prompt through the agent, renders the events, asks
 * again. The loop over turns stays inside the agent.
 */
export async function startTui(options: TuiOptions): Promise<void> {
  const { agent } = options;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTty = Boolean(input.isTTY && output.isTTY);
  const color = options.color ?? isTty;
  const { dim, bold } = palette(color);

  const write = (text: string) => void output.write(text);
  const status = createStatus(output, isTty, color);
  const unsubscribe = agent.subscribe(tuiRenderer({ write, color, status }));

  write(bold("mya") + dim(` · ${agent.model.provider}/${agent.modelName} · ${agent.cwd}`) + "\n");
  if (agent.session.file) write(dim(`session · ${agent.session.file}`) + "\n");
  write(dim("/help for commands · Enter steers · Alt+Enter follows up · ctrl+c interrupts · ctrl+d exits") + "\n");

  if (isTty) emitKeypressEvents(input);

  const rl = readline.createInterface({ input, output, terminal: isTty });
  rl.setPrompt(bold("› "));
  let running = false;
  // Enter submits a line. Alt+Enter does not: readline leaves the buffer
  // alone, and this listener takes it as a follow-up.
  if (isTty) {
    input.on("keypress", (_str: string, key: Key) => {
      if (key.name !== "return" || !key.meta || !running) return;
      const buffer = rl as readline.Interface & { line: string; cursor: number };
      const text = buffer.line.trim();
      buffer.line = "";
      buffer.cursor = 0;
      if (text === "" || text.startsWith("/")) return;
      agent.followUp(text);
    });
  }
  // Enter during a run is a steer. A line that arrives before the run starts
  // stays queued for the next prompt.
  const lines = lineQueue(rl, (line) => {
    if (!running) return false;
    const text = line.trim();
    if (text !== "" && !text.startsWith("/")) agent.steer(text);
    return true;
  });
  rl.on("SIGINT", () => {
    if (running) {
      agent.abort();
      return;
    }
    rl.close();
  });

  try {
    while (true) {
      write("\n");
      if (isTty) rl.prompt();
      else write(bold("› "));

      const line = await lines.next();
      if (line === undefined) break;

      const text = line.trim();
      if (text === "") continue;
      if (text.startsWith("/")) {
        if (handleCommand(text, { write, dim, agent, rl })) continue;
        break;
      }

      running = true;
      try {
        await agent.run(text);
      } catch (error) {
        write(`  error: ${(error as Error).message}\n`);
      } finally {
        running = false;
        status.stop();
      }
    }
  } finally {
    status.stop();
    unsubscribe();
    rl.close();
  }
}

/**
 * Buffers lines so none is lost while the agent is running. `duringRun`
 * returns true when it took the line (a steer). Otherwise the line waits
 * for the next prompt.
 */
function lineQueue(
  rl: readline.Interface,
  duringRun: (line: string) => boolean,
): { next: () => Promise<string | undefined> } {
  const pending: string[] = [];
  let waiting: ((line: string | undefined) => void) | undefined;
  let closed = false;

  const deliver = (line: string | undefined) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
      return true;
    }
    return false;
  };

  rl.on("line", (line: string) => {
    if (duringRun(line)) return;
    if (!deliver(line)) pending.push(line);
  });
  rl.on("close", () => {
    closed = true;
    deliver(undefined);
  });

  return {
    next() {
      const buffered = pending.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => {
        waiting = resolve;
      });
    },
  };
}

interface CommandContext {
  write: (text: string) => void;
  dim: (text: string) => string;
  agent: Agent;
  rl: readline.Interface;
}

/** Returns false when the session should end. */
function handleCommand(text: string, { write, dim, agent, rl }: CommandContext): boolean {
  const [command] = text.split(/\s+/);
  switch (command) {
    case "/help":
      write(dim(HELP) + "\n");
      return true;
    case "/tools":
      write(dim(`  ${agent.host.tools().map((tool) => tool.name).join(", ")}`) + "\n");
      return true;
    case "/session":
      write(dim(`  ${agent.session.file ?? "not persisted"}`) + "\n");
      return true;
    case "/clear":
      write("\u001b[2J\u001b[H");
      return true;
    case "/exit":
    case "/quit":
      rl.close();
      return false;
    default:
      write(dim(`  unknown command: ${command}. /help lists them.`) + "\n");
      return true;
  }
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createStatus(output: NodeJS.WritableStream, isTty: boolean, color: boolean): Status {
  if (!isTty) return { start: () => {}, stop: () => {} };
  const { dim } = palette(color);
  let timer: NodeJS.Timeout | undefined;

  const clear = () => {
    output.write("\r\u001b[2K");
  };

  return {
    start(label) {
      this.stop();
      const startedAt = Date.now();
      let frame = 0;
      timer = setInterval(() => {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        clear();
        output.write(dim(`  ${FRAMES[frame++ % FRAMES.length]} ${label} ${seconds}s`));
      }, 80);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      clear();
    },
  };
}
