import { spawn } from "node:child_process";
import { optionalNumber, requireString } from "./paths.js";
import type { Tool, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 60_000;
const SCORE = /^score:\s*(-?\d+(?:\.\d+)?)\s*$/gm;

/**
 * Runs a shell command and reports pass or fail from the exit code. A
 * `score:` line in the output is copied onto the result. Nothing here
 * decides what the score means.
 */
export const checkTool: Tool = {
  name: "check",
  description:
    "Run a shell command and report whether it passed. Exit code 0 is pass; any other exit is fail. If the command prints a line `score: <number>`, that number is recorded with the result. The harness does not interpret the score.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line passed to bash -c." },
      timeout_ms: {
        type: "number",
        description: `Kill the command after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  execute(args, context): Promise<ToolResult> {
    const command = requireString(args, "command");
    const timeoutMs = clamp(optionalNumber(args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: context.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;
      let timedOut = false;

      const append = (chunk: Buffer) => {
        if (truncated) return;
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT);
          truncated = true;
        }
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const onAbort = () => child.kill("SIGKILL");
      context.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        const passed = !timedOut && code === 0;
        const text = output.trimEnd();
        const score = lastScore(text);
        const report = {
          command,
          passed,
          output: text,
          ...(score === undefined ? {} : { score }),
        };
        const lines = [passed ? "pass" : "fail", text];
        if (truncated) lines.push(`(output truncated at ${MAX_OUTPUT} characters)`);
        if (timedOut) lines.push(`(killed after ${timeoutMs}ms)`);
        if (score !== undefined) lines.push(`score: ${score}`);
        resolve({
          output: lines.filter((line) => line !== "").join("\n"),
          ...(passed ? {} : { isError: true }),
          check: report,
        });
      };

      child.on("error", (error) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        const text = `failed to start command: ${(error as Error).message}`;
        resolve({
          output: `fail\n${text}`,
          isError: true,
          check: { command, passed: false, output: text },
        });
      });
      child.on("close", (code) => finish(code));
    });
  },
};

function lastScore(output: string): number | undefined {
  let score: number | undefined;
  for (const match of output.matchAll(SCORE)) {
    score = Number(match[1]);
  }
  return score;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
