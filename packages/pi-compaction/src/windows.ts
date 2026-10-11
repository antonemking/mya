/**
 * Input windows for the models Mya calls, looked up October 2026.
 * gpt-5.5 is 272k input on Codex and 1,050,000 on the OpenAI API, so the
 * key is provider plus model. A trailing -YYYY-MM-DD snapshot uses the base
 * id. Anything else, including gpt-5.5-pro, stays unknown.
 *
 * PI_CONTEXT_WINDOW overrides the table. An unknown model falls back to
 * 200000, the same constant the summary-only policy has always used.
 */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;

export interface WindowHit {
  window: number;
  note: string;
}

const WINDOW_TABLE: Array<{ provider: string; model: string } & WindowHit> = [
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
    note: "272k input budget. Codex advertises 400k and reserves 128k for output.",
  },
];

export type WindowSource = "option" | "env" | "table" | "fallback" | "default";

export interface ResolvedWindow {
  window: number;
  source: WindowSource;
  note?: string;
}

export function lookupContextWindow(provider: string, model: string): WindowHit | undefined {
  const exact = WINDOW_TABLE.find((row) => row.provider === provider && row.model === model);
  if (exact) return { window: exact.window, note: exact.note };
  const stripped = model.replace(DATE_SUFFIX, "");
  if (stripped === model) return undefined;
  const dated = WINDOW_TABLE.find((row) => row.provider === provider && row.model === stripped);
  if (!dated) return undefined;
  return { window: dated.window, note: dated.note };
}

export function parseWindow(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/_/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

export function resolveContextWindow(
  provider: string,
  model: string,
  options: { contextWindow?: number; modelWindow?: boolean },
  env: Record<string, string | undefined> = process.env,
): ResolvedWindow {
  if (options.contextWindow !== undefined) {
    return { window: options.contextWindow, source: "option" };
  }
  const fromEnv = parseWindow(env.PI_CONTEXT_WINDOW);
  if (fromEnv !== undefined) return { window: fromEnv, source: "env" };
  if (!options.modelWindow) return { window: FALLBACK_CONTEXT_WINDOW, source: "default" };
  const found = lookupContextWindow(provider, model);
  if (found) return { window: found.window, source: "table", note: found.note };
  return {
    window: FALLBACK_CONTEXT_WINDOW,
    source: "fallback",
    note: `No window for ${provider}/${model}. Using ${FALLBACK_CONTEXT_WINDOW}.`,
  };
}
