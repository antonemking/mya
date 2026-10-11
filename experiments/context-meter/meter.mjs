/**
 * Opt-in context meter. It watches the event stream and appends one JSON line
 * when a run ends. It does not rewrite context or stop the loop.
 *
 * PI_CONTEXT_WINDOW is intentionally unread: that is pi-compaction's policy
 * window, not the model's real limit. Set MYA_CONTEXT_WINDOW for a model that
 * is not in the table below.
 *
 *   mya -e ./experiments/context-meter/meter.mjs -p "..."
 *   node experiments/context-meter/report.mjs
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Input budgets that actually reject a request, looked up October 2026.
 * gpt-5.5 is 272k input on Codex and 1,050,000 on the OpenAI API, so the key
 * is provider plus model. A trailing -YYYY-MM-DD snapshot uses the base id.
 * Anything else, including gpt-5.5-pro, stays unknown.
 */
const WINDOW_TABLE = [
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    window: 200_000,
    note: "200k. This client does not enable Anthropic's 1M context beta.",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    window: 200_000,
    note: "200k. This client does not enable Anthropic's 1M context beta.",
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    window: 1_047_576,
    note: "1,047,576 token context window.",
  },
  {
    provider: "openai",
    model: "gpt-5.5",
    window: 1_050_000,
    note: "1,050,000 token context window on the OpenAI API.",
  },
  {
    provider: "openai-codex",
    model: "gpt-5.5",
    window: 272_000,
    note: "Compared to the 272k input budget. Codex advertises 400k and reserves 128k for output.",
  },
];

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;
const CONTEXT_STOP = "model_context_window_exceeded";
const DETAIL_MAX = 180;

/** Matched against error text and non-2xx bodies, not against a successful response. */
const OVERFLOW_PATTERNS = [
  /context_length_exceeded/i,
  /model_context_window_exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /context window/i,
  /exceeds the context/i,
  /input is too long/i,
  /\d+\s+tokens?\s*>\s*\d+\s+maximum/i,
  /context length/i,
];

export function lookupWindow(provider, model, env = process.env) {
  const raw = env.MYA_CONTEXT_WINDOW;
  if (raw !== undefined && String(raw).trim() !== "") {
    const parsed = parseWindow(raw);
    if (parsed === null) {
      return {
        window: null,
        windowSource: "unknown",
        windowNote: `MYA_CONTEXT_WINDOW=${JSON.stringify(String(raw).trim())} is not a positive integer`,
      };
    }
    return {
      window: parsed,
      windowSource: "env",
      windowNote: "MYA_CONTEXT_WINDOW overrides the built-in table.",
    };
  }

  const hit = findWindow(provider, model);
  if (!hit) {
    return {
      window: null,
      windowSource: "unknown",
      windowNote: "No window for this provider and model. Set MYA_CONTEXT_WINDOW to compare against a real limit.",
    };
  }
  return { window: hit.window, windowSource: "table", windowNote: hit.note };
}

/** Provider prompt size: fresh prefill plus cache read plus cache write. Output is not included. */
export function promptTokens(usage) {
  if (!usage) return 0;
  return number(usage.inputTokens) + number(usage.cachedInputTokens) + number(usage.cacheWriteTokens);
}

/**
 * chars/4 of the system prompt, tool schemas, and messages. Used only when a
 * turn never finishes, so there is no provider usage for the request that failed.
 */
export function estimateTokens(snapshot) {
  const json = JSON.stringify({
    system: snapshot?.system ?? "",
    tools: snapshot?.tools ?? [],
    messages: snapshot?.messages ?? [],
  });
  return Math.round(json.length / 4);
}

/**
 * max_turns wins over a context-looking body. A context stop on an otherwise
 * normal end (Claude can return model_context_window_exceeded with HTTP 200)
 * is a context ending. Output max_tokens and rate limits are not.
 */
export function classifyEnding({ reason, error, errorBodyDetail, contextStop }) {
  if (reason === "max_turns") return { endedBy: "turn_cap" };
  if (reason === "aborted") return { endedBy: "aborted" };

  const fromError = overflowDetail(typeof error === "string" ? error : "");
  const contextDetail = fromError || errorBodyDetail || (contextStop ? CONTEXT_STOP : null);
  if (reason === "error") {
    if (contextDetail) return { endedBy: "context", detail: contextDetail };
    const detail = clip(typeof error === "string" ? error : "");
    return detail ? { endedBy: "other_error", detail } : { endedBy: "other_error" };
  }
  if (contextStop) return { endedBy: "context", detail: contextDetail ?? CONTEXT_STOP };
  return { endedBy: "completed" };
}

export function overflowDetail(text) {
  if (typeof text !== "string" || text === "") return null;
  for (const pattern of OVERFLOW_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index - 60);
    const excerpt = text.slice(start, match.index + match[0].length + 80).replace(/\s+/g, " ").trim();
    return clip(excerpt);
  }
  return null;
}

/**
 * One meter per extension instance. State resets on every agent_start so a
 * TUI can reuse the same Agent. The log write happens once, at agent_end.
 */
export function contextMeter(options = {}) {
  const env = options.env ?? process.env;
  const write = options.write ?? writeRecord;
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  let run = null;

  return {
    name: "context-meter",
    onEvent(event) {
      try {
        handle(event);
      } catch (caught) {
        stderr(`mya: context meter: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    },
  };

  function handle(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "agent_start") {
      const limit = lookupWindow(event.provider, event.model, env);
      run = {
        sessionId: event.sessionId,
        sessionFile: event.sessionFile,
        cwd: event.cwd || options.cwd || process.cwd(),
        provider: event.provider,
        model: event.model,
        window: limit.window,
        windowSource: limit.windowSource,
        windowNote: limit.windowNote,
        peakUsage: null,
        openSnapshot: null,
        contextStop: false,
        errorBodyDetail: null,
        file: logFile(env, event.cwd || options.cwd || process.cwd()),
      };
      return;
    }
    if (!run) return;

    if (event.type === "context_snapshot") {
      run.openSnapshot = event;
      run.contextStop = false;
      run.errorBodyDetail = null;
      return;
    }
    if (event.type === "model_response") {
      const body = typeof event.body === "string" ? event.body : "";
      run.contextStop = body.includes(CONTEXT_STOP);
      const status = event.status;
      const failed = typeof status === "number" && (status < 200 || status >= 300);
      run.errorBodyDetail = failed ? overflowDetail(body) : null;
      return;
    }
    if (event.type === "turn_end") {
      const tokens = promptTokens(event.usage);
      run.peakUsage = run.peakUsage === null ? tokens : Math.max(run.peakUsage, tokens);
      run.openSnapshot = null;
      return;
    }
    if (event.type !== "agent_end") return;

    const record = finish(run, event);
    const file = run.file;
    run = null;
    write(record, file);
  }
}

export default function load(context = {}) {
  return contextMeter({ cwd: context.cwd });
}

function finish(run, event) {
  const classified = classifyEnding({
    reason: event.reason,
    error: event.error,
    errorBodyDetail: run.errorBodyDetail,
    contextStop: run.contextStop,
  });
  const estimate = run.openSnapshot ? safeEstimate(run.openSnapshot) : null;
  const usage = run.peakUsage;
  let peakTokens = null;
  let peakSource = null;
  if (classified.endedBy === "context" && estimate !== null && (usage === null || estimate > usage)) {
    peakTokens = estimate;
    peakSource = "estimate";
  } else if (usage !== null) {
    peakTokens = usage;
    peakSource = "usage";
  } else if (estimate !== null) {
    peakTokens = estimate;
    peakSource = "estimate";
  }

  const record = {
    at: event.at,
    sessionId: run.sessionId,
    cwd: run.cwd,
    provider: run.provider,
    model: run.model,
    window: run.window,
    windowSource: run.windowSource,
    turns: event.turns,
    reason: event.reason,
    endedBy: classified.endedBy,
    peakUsageTokens: usage,
    peakEstimateTokens: estimate,
    peakTokens,
    peakSource,
    ratio: typeof run.window === "number" && peakTokens !== null ? peakTokens / run.window : null,
  };
  if (run.sessionFile) record.sessionFile = run.sessionFile;
  if (run.windowNote) record.windowNote = run.windowNote;
  if (classified.detail) record.detail = classified.detail;
  return record;
}

function safeEstimate(snapshot) {
  try {
    return estimateTokens(snapshot);
  } catch {
    return null;
  }
}

function findWindow(provider, model) {
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  const exact = WINDOW_TABLE.find((row) => row.provider === provider && row.model === model);
  if (exact) return exact;
  const dated = DATE_SUFFIX.exec(model);
  if (!dated) return undefined;
  const base = model.slice(0, dated.index);
  return WINDOW_TABLE.find((row) => row.provider === provider && row.model === base);
}

function parseWindow(raw) {
  const text = String(raw).trim().replaceAll("_", "");
  if (!/^[1-9]\d*$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

function logFile(env, cwd) {
  const chosen = env.MYA_CONTEXT_METER_FILE;
  if (chosen !== undefined && String(chosen).trim() !== "") return String(chosen).trim();
  return join(cwd, ".mya", "context-meter.jsonl");
}

function writeRecord(record, file) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clip(text) {
  if (typeof text !== "string") return null;
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") return null;
  return one.length <= DETAIL_MAX ? one : `${one.slice(0, DETAIL_MAX - 1)}…`;
}
