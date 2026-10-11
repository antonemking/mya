import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentEvent, Extension, Message, TransformContextInput } from "pi-agent";

/**
 * A live picture of the loop in a browser tab. Another subscriber to the
 * events the harness already emits, plus a read-only look at the context each
 * call sends. It drives nothing and changes nothing.
 */
export interface VizOptions {
  /** Defaults to $MYA_VIZ_PORT or 7337, then the next free port above it. 0 picks any. */
  port?: number;
  /** Open a browser tab once the server is up. Defaults to true unless MYA_NO_BROWSER is set. */
  open?: boolean;
  log?: (text: string) => void;
  /** Items kept for a page that connects late or reloads. */
  maxHistory?: number;
}

export interface VizExtension extends Extension {
  /** Resolves once the server is listening. */
  url: Promise<string>;
  /**
   * Seed the page with a recorded run. Timestamps come from the log, so
   * Replay run follows the original pace. The model is not called.
   */
  load(events: AgentEvent[]): void;
  close(): void;
}

/** What the page receives. `t` is when the harness saw it, for replay timing. */
export type VizItem =
  | { kind: "event"; t: number; event: unknown }
  | {
      kind: "context";
      t: number;
      turn: number;
      model: string;
      system: string;
      tools: Array<{ name: string; description: string; chars: number }>;
      messages: ContextEntry[];
    };

export interface ContextEntry {
  role: string;
  chars: number;
  preview: string;
  toolName?: string;
  kind?: string;
}

const DEFAULT_PORT = 7337;
const PREVIEW_CHARS = 4000;
const OUTPUT_CHARS = 20_000;

export function viz(options: VizOptions = {}): VizExtension {
  const log = options.log ?? ((text: string) => void process.stderr.write(`mya: ${text}\n`));
  const maxHistory = options.maxHistory ?? 20_000;
  const page = readFileSync(new URL("../page.html", import.meta.url), "utf8");
  const bootedAt = Date.now();

  const history: string[] = [];
  const clients = new Set<ServerResponse>();
  let port = 0;

  const send = (item: VizItem) => {
    const line = JSON.stringify(item);
    history.push(line);
    if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
    for (const client of clients) client.write(`data: ${line}\n\n`);
  };

  const server = createServer((req, res) => handle(req, res));
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // Only this machine, by name: guards against DNS rebinding.
    const host = req.headers.host ?? "";
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowed.includes(host)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const path = (req.url ?? "/").split("?")[0];
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
      return;
    }
    if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      // A viewer must not keep a finished `mya -p` alive.
      req.socket.unref();
      res.write(`data: ${JSON.stringify({ kind: "hello", pid: process.pid, bootedAt })}\n\n`);
      res.write(`data: ${JSON.stringify({ kind: "history-start" })}\n\n`);
      for (const line of history) res.write(`data: ${line}\n\n`);
      res.write(`data: ${JSON.stringify({ kind: "history-end" })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404).end();
  };

  const ping = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, 15_000);
  ping.unref();

  const url = listen(server, options.port ?? envPort() ?? DEFAULT_PORT).then((bound) => {
    port = bound;
    server.unref();
    const address = `http://127.0.0.1:${bound}`;
    log(`viz at ${address}`);
    if (options.open ?? (!process.env.MYA_NO_BROWSER && process.env.MYA_VIZ_OPEN !== "0")) openBrowser(address);
    return address;
  });
  url.catch((error: Error) => log(`viz could not start: ${error.message}`));

  return {
    name: "viz",
    url,

    onEvent(event: AgentEvent) {
      if (event.type === "context_snapshot") {
        send(contextItem(event, Date.now()));
        return;
      }
      send({ kind: "event", t: Date.now(), event: sanitizeEvent(event) });
    },

    load(events: AgentEvent[]) {
      for (const item of eventItems(events)) send(item);
    },

    transformContext(input: TransformContextInput): Message[] {
      return input.messages;
    },

    close() {
      clearInterval(ping);
      for (const client of clients) client.end();
      server.close();
    },
  };
}

/**
 * Recorded events become the same items a live run would send. Events that
 * carry `at` keep it. Deltas, which have no clock of their own, are spread
 * between the stamped events around them.
 */
export function eventItems(events: AgentEvent[]): VizItem[] {
  const stamped = events.map((event) => ("at" in event && typeof event.at === "number" ? event.at : undefined));
  return events.map((event, index) => {
    const t = stamped[index] ?? spread(stamped, index);
    if (event.type === "context_snapshot") return contextItem(event, t);
    return { kind: "event" as const, t, event: sanitizeEvent(event) };
  });
}

/** The page's context row, built from the snapshot the loop recorded. */
export function contextItem(event: Extract<AgentEvent, { type: "context_snapshot" }>, t: number): VizItem {
  return {
    kind: "context",
    t,
    turn: event.turn,
    model: event.model,
    system: event.system,
    tools: event.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      chars: JSON.stringify(tool).length,
    })),
    messages: event.messages.map(summarizeMessage),
  };
}

function spread(stamped: Array<number | undefined>, index: number): number {
  let prev = index;
  while (prev >= 0 && stamped[prev] === undefined) prev -= 1;
  let next = index;
  while (next < stamped.length && stamped[next] === undefined) next += 1;
  const start = prev >= 0 ? stamped[prev]! : (stamped[next] ?? 0);
  const end = next < stamped.length ? stamped[next]! : start;
  const span = next - prev;
  return start + (end - start) * (span > 0 ? (index - prev) / span : 0);
}

/** Big and secret-ish payloads stay out of the page: encrypted reasoning, huge tool output. */
export function sanitizeEvent(event: AgentEvent): unknown {
  if (event.type === "model_request" || event.type === "model_response") {
    const { body: _body, ...rest } = event;
    return { ...rest, chars: event.body.length };
  }
  if (event.type === "turn_end") {
    return {
      ...event,
      message: {
        ...event.message,
        content: event.message.content.map((block) =>
          block.type === "opaque"
            ? { type: "opaque", provider: block.provider, bytes: JSON.stringify(block.data ?? null).length }
            : block,
        ),
      },
    };
  }
  if (event.type === "tool_execution_end" && event.outcome.output.length > OUTPUT_CHARS) {
    return {
      ...event,
      outcome: {
        ...event.outcome,
        output: `${event.outcome.output.slice(0, OUTPUT_CHARS)}\n… (${event.outcome.output.length} chars total)`,
      },
    };
  }
  return event;
}

export function summarizeMessage(message: Message): ContextEntry {
  switch (message.role) {
    case "user":
      return { role: "user", chars: message.content.length, preview: clip(message.content) };
    case "tool":
      return { role: "tool", chars: message.content.length, preview: clip(message.content), toolName: message.toolName };
    case "assistant": {
      const text = message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "tool_call"
              ? `→ ${block.name}(${block.rawArguments})`
              : "",
        )
        .filter(Boolean)
        .join("\n");
      const chars = message.content.reduce(
        (sum, block) =>
          sum +
          (block.type === "text"
            ? block.text.length
            : block.type === "tool_call"
              ? block.name.length + block.rawArguments.length
              : JSON.stringify(block.data ?? null).length),
        0,
      );
      return { role: "assistant", chars, preview: clip(text) };
    }
    default:
      return {
        role: "custom",
        kind: message.kind,
        chars: JSON.stringify(message.payload ?? null).length,
        preview: clip(JSON.stringify(message.payload ?? null)),
      };
  }
}

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function envPort(): number | undefined {
  const raw = process.env.MYA_VIZ_PORT;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A second `mya --viz` gets the next port instead of failing. */
async function listen(server: Server, first: number): Promise<number> {
  const attempts = first === 0 ? [0] : Array.from({ length: 10 }, (_, i) => first + i);
  for (const candidate of attempts) {
    const bound = await new Promise<number | undefined>((resolve) => {
      const onError = () => resolve(undefined);
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : candidate);
      });
    });
    if (bound !== undefined) return bound;
  }
  throw new Error(`no free port from ${first} to ${first + 9}`);
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is logged; that is enough.
  }
}

export default function createViz(): VizExtension {
  return viz();
}
