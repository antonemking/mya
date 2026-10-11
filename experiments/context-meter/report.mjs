/**
 * Summarize a context-meter log.
 *
 *   node experiments/context-meter/report.mjs
 *   node experiments/context-meter/report.mjs path/to/context-meter.jsonl
 *
 * The file defaults to $MYA_CONTEXT_METER_FILE, then ./.mya/context-meter.jsonl.
 * A missing file exits 1. An empty file prints "no runs" and exits 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIST_CAP = 20;

export function loadRecords(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export function summarize(records) {
  const counts = { context: 0, turn_cap: 0, other_error: 0, aborted: 0, completed: 0 };
  let windowUnknown = 0;
  const groups = new Map();

  for (const record of records) {
    if (Object.hasOwn(counts, record.endedBy)) counts[record.endedBy] += 1;
    if (record.window == null) windowUnknown += 1;

    const key = `${record.provider ?? "unknown"}/${record.model ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      group = { model: key, runs: 0, ratios: [] };
      groups.set(key, group);
    }
    group.runs += 1;
    if (typeof record.ratio === "number" && Number.isFinite(record.ratio)) group.ratios.push(record.ratio);
  }

  const runs = records.length;
  return {
    runs,
    context: counts.context,
    turnCap: counts.turn_cap,
    otherError: counts.other_error,
    aborted: counts.aborted,
    completed: counts.completed,
    overflowRate: runs === 0 ? null : counts.context / runs,
    turnCapRate: runs === 0 ? null : counts.turn_cap / runs,
    windowUnknown,
    models: [...groups.values()]
      .map((group) => ({ model: group.model, runs: group.runs, medianRatio: median(group.ratios) }))
      .sort((a, b) => a.model.localeCompare(b.model) || b.runs - a.runs),
    contextRuns: records.filter((record) => record.endedBy === "context"),
    turnCapRuns: records.filter((record) => record.endedBy === "turn_cap"),
  };
}

export function formatReport(summary, options = {}) {
  if (summary.runs === 0) {
    const skipped = options.skipped ?? 0;
    return skipped > 0 ? `no runs\nskipped ${skipped} unreadable lines\n` : "no runs\n";
  }

  const lines = [
    `overflow rate: ${formatRate(summary.context, summary.runs)}  — ended because the context window was exceeded`,
    `turn-cap rate: ${formatRate(summary.turnCap, summary.runs)}`,
    `completed: ${summary.completed}    other errors: ${summary.otherError}    aborted: ${summary.aborted}`,
    `window unknown: ${summary.windowUnknown}`,
    "",
    "per model:",
  ];

  for (const model of summary.models) {
    const ratio = model.medianRatio === null ? "—" : `${(model.medianRatio * 100).toFixed(1)}%`;
    lines.push(`  ${model.model}  runs ${model.runs}  median peak/window ${ratio}`);
  }

  lines.push("", "context endings:");
  lines.push(...listRuns(summary.contextRuns));
  lines.push("", "turn-cap endings:");
  lines.push(...listRuns(summary.turnCapRuns));

  const skipped = options.skipped ?? 0;
  if (skipped > 0) lines.push("", `skipped ${skipped} unreadable lines`);
  return `${lines.join("\n")}\n`;
}

function listRuns(records) {
  if (records.length === 0) return ["  none"];
  const lines = records.slice(0, LIST_CAP).map((record) => {
    const bits = [
      record.sessionId ?? "?",
      `${record.provider ?? "unknown"}/${record.model ?? "unknown"}`,
      `turns ${record.turns ?? "?"}`,
      formatPeak(record),
    ];
    if (record.detail) bits.push(record.detail);
    return `  ${bits.join("  ")}`;
  });
  if (records.length > LIST_CAP) lines.push(`  … and ${records.length - LIST_CAP} more`);
  return lines;
}

function formatPeak(record) {
  if (typeof record.peakTokens !== "number") return "peak —";
  const limit = typeof record.window === "number" ? String(record.window) : "—";
  const source = record.peakSource ? ` (${record.peakSource})` : "";
  return `peak ${record.peakTokens}/${limit}${source}`;
}

function formatRate(count, runs) {
  return `${count}/${runs} (${((count / runs) * 100).toFixed(1)}%)`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function main() {
  const file = process.argv[2] || process.env.MYA_CONTEXT_METER_FILE || join(process.cwd(), ".mya", "context-meter.jsonl");
  if (!existsSync(file)) {
    console.error(`mya: context meter: no log at ${file}`);
    process.exit(1);
  }
  const { records, skipped } = loadRecords(readFileSync(file, "utf8"));
  process.stdout.write(formatReport(summarize(records), { skipped }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
