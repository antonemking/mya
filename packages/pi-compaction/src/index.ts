import type { CustomMessage, Extension, Message, TransformContextInput } from "pi-agent";
import { emptyUsage, type ModelClient, type StreamRequest, type ToolResultMessage, type Usage } from "pi-ai";
import { resolveContextWindow, type ResolvedWindow } from "./windows.js";

/**
 * Compaction as a policy, installed on `transformContext`. Core ships the
 * hook and no policy; this package is the policy.
 *
 * The default policy summarizes the old turns once the estimate crosses
 * `contextWindow × threshold` (200000 × 0.8, or $PI_CONTEXT_WINDOW).
 *
 * `PI_COMPACT_STAGED=1` follows the paper's staged order instead: elide stale
 * bulky tool outputs at 0.6 of the window, and call the summarizer only if
 * the transcript is still over 0.85. Recent turns stay verbatim. There is no
 * recall tool. The same switch sizes the window from the model table.
 * `PI_COMPACT_MODEL_WINDOW=1` sizes the window without elision. Either way
 * the original tool output stays in the session file.
 */
export const COMPACTION_KIND = "pi/compaction";

export interface CompactionPayload {
  summary: string;
  /** How many leading transcript messages this summary stands in for. */
  covers: number;
  /** How many messages went into it. */
  summarized: number;
  at: number;
  usage: Usage;
  /** Tool outputs stubbed before this summary. Absent on the default policy. */
  elided?: number;
}

export interface CompactionOptions {
  /** Tokens the model can hold. Defaults to $PI_CONTEXT_WINDOW or 200000. */
  contextWindow?: number;
  /** Fraction of the window that triggers a compaction. Defaults to 0.8, or 0.85 when staged. */
  threshold?: number;
  /** Soft line for elision. Staged policy only. Defaults to 0.6, and never above `threshold`. */
  softThreshold?: number;
  /** Messages to keep verbatim. Snapped forward to a user message. */
  keepTail?: number;
  /** Cap on the summary itself. */
  maxSummaryTokens?: number;
  /** Override the estimator. The default counts characters. */
  estimateTokens?: (messages: Message[]) => number;
  /** Where the notice goes. Defaults to stderr. */
  log?: (text: string) => void;
  /**
   * Elide stale bulky tool output before summarizing.
   * Defaults to $PI_COMPACT_STAGED. Off keeps the summary-only policy.
   */
  staged?: boolean;
  /**
   * Size the window from the model table. Turns on with `staged`.
   * Otherwise defaults to $PI_COMPACT_MODEL_WINDOW.
   */
  modelWindow?: boolean;
  /** Tool output longer than this is bulky. Defaults to 2000 characters. */
  bulkyChars?: number;
  /** Fraction of the window kept as recent turns on the staged policy. Defaults to 0.3. */
  recentFraction?: number;
}

const SUMMARY_SYSTEM = [
  "You compress a coding session transcript for reuse as context.",
  "Write a dense summary that another model can act on without the original messages.",
  "Keep file paths, commands, tool results that still matter, decisions, and open work.",
  "Drop pleasantries and repetition. No preamble, just the summary.",
].join(" ");

const STUB_PREFIX = "[tool output elided:";
const MIN_RECENT_TURNS = 2;

export function compaction(options: CompactionOptions = {}): Extension {
  const staged = options.staged ?? envFlag("PI_COMPACT_STAGED");
  const modelWindow = options.modelWindow ?? (staged || envFlag("PI_COMPACT_MODEL_WINDOW"));
  const threshold = options.threshold ?? numberFromEnv("PI_COMPACT_THRESHOLD") ?? (staged ? 0.85 : 0.8);
  const softFraction = Math.min(threshold, options.softThreshold ?? numberFromEnv("PI_COMPACT_SOFT") ?? 0.6);
  const configuredTail = options.keepTail ?? numberFromEnv("PI_COMPACT_KEEP_TAIL");
  const keepTail = configuredTail ?? 6;
  const maxSummaryTokens = options.maxSummaryTokens ?? 2048;
  const estimate = options.estimateTokens ?? estimateTokens;
  const log = options.log ?? ((text: string) => void process.stderr.write(`mya: ${text}\n`));
  const bulkyChars = options.bulkyChars ?? numberFromEnv("PI_COMPACT_BULKY_CHARS") ?? 2_000;
  const recentFraction = options.recentFraction ?? 0.3;
  // A caller-supplied estimator is the whole policy. Calibration is for the built-in one.
  const track = (staged || modelWindow) && options.estimateTokens === undefined;

  let ratio: number | null = null;
  let pendingChars = 0;
  let announced = false;

  return {
    name: "compaction",

    onEvent(event) {
      if (!track || event.type !== "turn_end") return;
      const usage = event.usage;
      const tokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
      if (tokens > 0 && pendingChars > 0) ratio = tokens / pendingChars;
    },

    async transformContext(input: TransformContextInput): Promise<Message[]> {
      const resolved = resolveContextWindow(input.modelClient.provider, input.model, {
        contextWindow: options.contextWindow,
        modelWindow,
      });
      announce(resolved, input);

      const contextWindow = resolved.window;
      const limit = Math.floor(contextWindow * threshold);
      const softLimit = Math.floor(contextWindow * softFraction);
      const snapshot = latestSnapshot(input.messages);
      const rest = liveMessages(input.messages, snapshot.covers);
      const pinned = staged ? pinnedUser(input.messages, rest) : undefined;
      const current = renderView(snapshot, rest, pinned);
      const tokens = measure(input, current);
      const trigger = staged ? softLimit : limit;

      if (tokens < trigger) return finish(input, current);

      const tailStart = tailIndex(rest, contextWindow);
      if (!staged) {
        if (tailStart === 0) return finish(input, current);
        const summarized = await writeSummary({
          input,
          snapshot,
          older: rest.slice(0, tailStart),
          tail: rest.slice(tailStart),
          tokens,
          limit,
          elided: 0,
        });
        return finish(input, summarized);
      }

      const middle = elideRange(rest, 0, tailStart, bulkyChars);
      let elided = middle.count;
      const elidedView = renderView(snapshot, middle.entries, pinned);
      const afterElide = measure(input, elidedView);
      if (afterElide < limit) {
        if (elided > 0) {
          log(`elided ${elided} tool outputs at ~${afterElide} tokens (limit ${limit}); summary skipped`);
        }
        return finish(input, elidedView);
      }

      if (tailStart === 0) {
        const fitted = fitByElision(input, snapshot, rest, pinned, limit);
        return finish(input, fitted);
      }

      const protectedIndex = firstUserIndex(input.messages);
      const older = middle.entries.slice(0, tailStart).filter((entry) => entry.index !== protectedIndex);
      const tail = rest.slice(tailStart);
      if (older.length === 0) {
        const fitted = fitByElision(input, snapshot, middle.entries, pinned, limit);
        return finish(input, fitted);
      }

      const summarized = await writeSummary({
        input,
        snapshot,
        older,
        tail,
        pinned: pinnedUser(input.messages, tail),
        tokens: afterElide,
        limit,
        elided,
      });
      if (measure(input, summarized) < limit) return finish(input, summarized);

      const tightened = elideMessagesUntil(summarized, bulkyChars, (messages) => measure(input, messages) >= limit);
      const stubbed = countStubs(summarized, tightened);
      if (stubbed > 0) {
        log(
          `elided ${stubbed} more tool outputs after the summary at ~${measure(input, tightened)} tokens (limit ${limit})`,
        );
      }
      return finish(input, tightened);
    },
  };

  function finish(input: TransformContextInput, messages: Message[]): Message[] {
    if (track) pendingChars = promptChars(input.system, input.tools, messages);
    return messages;
  }

  function measure(input: TransformContextInput, messages: Message[]): number {
    if (!track) return estimate(messages);
    const chars = promptChars(input.system, input.tools, messages);
    if (ratio !== null) return Math.max(1, Math.round(chars * ratio));
    return Math.ceil(chars / 4);
  }

  function tailIndex(entries: Entry[], contextWindow: number): number {
    if (staged && configuredTail === undefined) {
      return recentTailStart(entries, Math.floor(contextWindow * recentFraction));
    }
    return chooseTailStart(entries, keepTail);
  }

  function announce(resolved: ResolvedWindow, input: TransformContextInput): void {
    if (!modelWindow || announced) return;
    if (resolved.source === "option" || resolved.source === "default") return;
    announced = true;
    const who = `${input.modelClient.provider}/${input.model}`;
    if (resolved.source === "table") {
      log(`context window ${resolved.window} for ${who}`);
      return;
    }
    if (resolved.source === "env") {
      log(`context window ${resolved.window} from PI_CONTEXT_WINDOW`);
      return;
    }
    log(`no context window for ${who}; using ${resolved.window}`);
  }

  async function writeSummary(args: {
    input: TransformContextInput;
    snapshot: Snapshot;
    older: Entry[];
    tail: Entry[];
    pinned?: Message;
    tokens: number;
    limit: number;
    elided: number;
  }): Promise<Message[]> {
    const { summary, usage } = await summarize({
      client: args.input.modelClient,
      model: args.input.model,
      maxSummaryTokens,
      previous: args.snapshot.summary,
      messages: args.older.map((entry) => entry.message),
    });

    const covers = args.older[args.older.length - 1]!.index + 1;
    const payload: CompactionPayload = {
      summary,
      covers,
      summarized: args.older.length,
      at: Date.now(),
      usage,
    };
    if (args.elided > 0) payload.elided = args.elided;
    const record: CustomMessage = { role: "custom", kind: COMPACTION_KIND, payload };
    await args.input.append(record);

    const head =
      args.elided > 0
        ? `elided ${args.elided} tool outputs, then compacted ${args.older.length} messages at ~${args.tokens} tokens (limit ${args.limit}); `
        : `compacted ${args.older.length} messages at ~${args.tokens} tokens (limit ${args.limit}); `;
    log(
      head +
        `summary call · in ${usage.inputTokens} (cache read ${usage.cachedInputTokens}, write ${usage.cacheWriteTokens}) out ${usage.outputTokens}`,
    );

    return renderView({ summary, covers }, args.tail, args.pinned);
  }

  function fitByElision(
    input: TransformContextInput,
    snapshot: Snapshot,
    entries: Entry[],
    pinned: Message | undefined,
    limit: number,
  ): Message[] {
    const viewOf = (next: Entry[]): Message[] => renderView(snapshot, next, pinnedUser(input.messages, next) ?? pinned);
    const fitted = elideEntriesUntil(entries, bulkyChars, (next) => measure(input, viewOf(next)) >= limit);
    const view = viewOf(fitted.entries);
    if (fitted.count > 0) {
      log(`elided ${fitted.count} tool outputs at ~${measure(input, view)} tokens (limit ${limit}); summary skipped`);
    }
    return view;
  }
}

interface Entry {
  message: Message;
  /** Index in the full transcript, so `covers` survives later appends. */
  index: number;
}

interface Snapshot {
  summary?: string;
  covers: number;
}

function latestSnapshot(messages: Message[]): Snapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || !isCompactionRecord(message)) continue;
    const payload = message.payload as CompactionPayload;
    return { summary: payload.summary, covers: payload.covers };
  }
  return { covers: 0 };
}

/** Everything the summary does not already stand for, minus the records themselves. */
function liveMessages(messages: Message[], covers: number): Entry[] {
  const entries: Entry[] = [];
  for (let index = covers; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || isCompactionRecord(message)) continue;
    entries.push({ message, index });
  }
  return entries;
}

function renderView(snapshot: Snapshot, entries: Entry[], pinned?: Message): Message[] {
  const tail = entries.map((entry) => entry.message);
  const head: Message[] = [];
  if (pinned) head.push(pinned);
  if (snapshot.summary) head.push({ role: "user", content: summaryPreamble(snapshot.summary) });
  return [...head, ...tail];
}

function summaryPreamble(summary: string): string {
  return [
    "Summary of the earlier part of this session, which has been compacted out of the transcript:",
    "",
    summary,
    "",
    "Continue from here. The messages that follow are the recent, uncompacted turns.",
  ].join("\n");
}

function firstUserIndex(messages: Message[]): number {
  return messages.findIndex((message) => message.role === "user");
}

/** The first user task stays verbatim once a summary has covered it. */
function pinnedUser(messages: Message[], live: Entry[]): Message | undefined {
  const index = firstUserIndex(messages);
  if (index < 0) return undefined;
  if (live.some((entry) => entry.index === index)) return undefined;
  return messages[index];
}

/**
 * A tail must start at a user message: a tool result whose tool call was
 * summarized away is a malformed request.
 */
function chooseTailStart(entries: Entry[], keepTail: number): number {
  let start = Math.max(0, entries.length - keepTail);
  while (start < entries.length && entries[start]!.message.role !== "user") start += 1;
  return start >= entries.length ? 0 : start;
}

/**
 * Keep at least the last two turns, and more of them while they fit in
 * `budget` tokens. The cut is always on a user message.
 */
function recentTailStart(entries: Entry[], budget: number): number {
  const turns: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]!.message.role === "user") turns.push(i);
  }
  if (turns.length === 0) return 0;
  const floorAt = Math.max(0, turns.length - MIN_RECENT_TURNS);
  let start = turns[floorAt]!;
  for (let t = floorAt - 1; t >= 0; t -= 1) {
    const candidate = turns[t]!;
    const tail = entries.slice(candidate).map((entry) => entry.message);
    if (estimateTokens(tail) > budget) break;
    start = candidate;
  }
  return start;
}

function elideRange(entries: Entry[], from: number, to: number, bulkyChars: number): { entries: Entry[]; count: number } {
  if (to <= from) return { entries, count: 0 };
  let count = 0;
  const next = entries.map((entry, i) => {
    if (i < from || i >= to) return entry;
    const replaced = maybeStub(entry.message, bulkyChars);
    if (replaced === entry.message) return entry;
    count += 1;
    return { message: replaced, index: entry.index };
  });
  return { entries: next, count };
}

function elideEntriesUntil(
  entries: Entry[],
  bulkyChars: number,
  tooBig: (entries: Entry[]) => boolean,
): { entries: Entry[]; count: number } {
  if (!tooBig(entries)) return { entries, count: 0 };
  let current = entries;
  let count = 0;
  for (let i = 0; i < current.length; i += 1) {
    const entry = current[i];
    if (!entry) continue;
    const replaced = maybeStub(entry.message, bulkyChars);
    if (replaced === entry.message) continue;
    current = current.slice();
    current[i] = { message: replaced, index: entry.index };
    count += 1;
    if (!tooBig(current)) break;
  }
  return { entries: current, count };
}

function elideMessagesUntil(
  messages: Message[],
  bulkyChars: number,
  tooBig: (messages: Message[]) => boolean,
): Message[] {
  if (!tooBig(messages)) return messages;
  let current = messages;
  for (let i = 0; i < current.length; i += 1) {
    const message = current[i];
    if (!message) continue;
    const replaced = maybeStub(message, bulkyChars);
    if (replaced === message) continue;
    current = current.slice();
    current[i] = replaced;
    if (!tooBig(current)) break;
  }
  return current;
}

function countStubs(before: Message[], after: Message[]): number {
  let count = 0;
  for (let i = 0; i < after.length; i += 1) {
    const next = after[i];
    const prev = before[i];
    if (next && prev && next !== prev && next.role === "tool" && next.content.startsWith(STUB_PREFIX)) count += 1;
  }
  return count;
}

function maybeStub(message: Message, bulkyChars: number): Message {
  if (message.role !== "tool") return message;
  if (message.content.length <= bulkyChars) return message;
  if (message.content.startsWith(STUB_PREFIX)) return message;
  const stub = stubFor(message);
  if (stub.length >= message.content.length) return message;
  return { ...message, content: stub };
}

function stubFor(message: ToolResultMessage): string {
  const lines = message.content.split("\n").length;
  const chars = message.content.length;
  return `${STUB_PREFIX} ${lines} lines / ${chars} chars. Re-read or re-run to get it again.]`;
}

async function summarize(input: {
  client: ModelClient;
  model: string;
  maxSummaryTokens: number;
  previous?: string;
  messages: Message[];
}): Promise<{ summary: string; usage: Usage }> {
  const prompt = [
    input.previous ? `Summary so far:\n${input.previous}\n` : "",
    "Transcript to compress:",
    "",
    render(input.messages),
  ]
    .filter(Boolean)
    .join("\n");

  const request: StreamRequest = {
    model: input.model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxTokens: input.maxSummaryTokens,
    // One-off prefix. Nobody will read this cache, so do not pay to write it.
    cache: false,
  };

  let summary = "";
  let usage = emptyUsage();
  for await (const event of input.client.stream(request)) {
    if (event.type === "message_done") {
      summary = event.message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      usage = event.usage;
    }
  }

  if (summary === "") throw new Error("compaction: the summary call returned no text");
  return { summary, usage };
}

function render(messages: Message[]): string {
  return messages
    .map((message) => {
      switch (message.role) {
        case "user":
          return `USER: ${message.content}`;
        case "assistant":
          return `ASSISTANT: ${message.content
            .map((block) =>
              block.type === "text"
                ? block.text
                : block.type === "tool_call"
                  ? `[called ${block.name} with ${block.rawArguments}]`
                  : "",
            )
            .filter((line) => line !== "")
            .join("\n")}`;
        case "tool":
          return `TOOL RESULT (${message.toolName})${message.isError ? " [error]" : ""}: ${message.content}`;
        default:
          return "";
      }
    })
    .filter((line) => line !== "")
    .join("\n\n");
}

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messageChars(messages) / 4);
}

function messageChars(messages: Message[]): number {
  let characters = 0;
  for (const message of messages) characters += JSON.stringify(message).length;
  return characters;
}

function promptChars(system: string, tools: unknown, messages: Message[]): number {
  return JSON.stringify(system).length + JSON.stringify(tools).length + messageChars(messages);
}

export function isCompactionRecord(message: Message): message is CustomMessage {
  return message.role === "custom" && message.kind === COMPACTION_KIND;
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export { FALLBACK_CONTEXT_WINDOW, lookupContextWindow, resolveContextWindow } from "./windows.js";
export type { ResolvedWindow } from "./windows.js";

export default compaction;
