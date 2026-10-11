import type { Usage } from "pi-ai";

/**
 * Shared formatting. Print mode and the TUI render a turn the same way, so
 * the two views cannot drift apart.
 */
export interface Palette {
  dim: (text: string) => string;
  bold: (text: string) => string;
}

export function palette(color: boolean): Palette {
  if (!color) return { dim: (t) => t, bold: (t) => t };
  return {
    dim: (t) => `\u001b[2m${t}\u001b[0m`,
    bold: (t) => `\u001b[1m${t}\u001b[0m`,
  };
}

/** Prefill splits three ways: fresh, read from cache, written to cache. */
export function usageLine(usage: Usage): string {
  return `in ${usage.inputTokens} (cache read ${usage.cachedInputTokens}, write ${usage.cacheWriteTokens}) out ${usage.outputTokens}`;
}

export function toolLine(name: string, args: unknown, raw: string): string {
  return `⏺ ${name} ${compactArgs(args, raw)}`;
}

export function toolResultLine(outcome: { output: string; isError?: boolean; refusedBy?: string }, durationMs: number): string {
  const mark = outcome.isError ? "✗" : "✓";
  const by = outcome.refusedBy ? ` refused by ${outcome.refusedBy}:` : "";
  return `${mark}${by} ${summarize(outcome.output)} · ${durationMs}ms`;
}

export function compactArgs(args: unknown, raw: string): string {
  let text: string;
  try {
    text = args === undefined ? raw : JSON.stringify(args);
  } catch {
    text = raw;
  }
  return clip(text ?? "", 160);
}

export function summarize(output: string): string {
  const lines = output.split("\n");
  const first = clip(lines[0] ?? "", 120);
  return lines.length > 1 ? `${first} (+${lines.length - 1} lines)` : first;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
