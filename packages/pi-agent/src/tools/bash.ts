import { spawn } from "node:child_process";
import { optionalNumber, requireString } from "./paths.js";
import type { Tool, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 60_000;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command with the working directory as cwd. Runs as the current user with no sandbox. Returns combined stdout and stderr plus the exit code. Foreground only.",
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

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);

        const parts: string[] = [];
        if (output.trim() !== "") parts.push(output.trimEnd());
        if (truncated) parts.push(`(output truncated at ${MAX_OUTPUT} characters)`);
        if (timedOut) parts.push(`(killed after ${timeoutMs}ms)`);
        if (code !== 0 || signal) {
          parts.push(`(exit code ${code ?? `signal ${signal}`})`);
        }
        if (parts.length === 0) parts.push("(no output, exit code 0)");

        resolve({ output: parts.join("\n"), isError: timedOut || code !== 0 });
      };

      child.on("error", (error) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        resolve({ output: `failed to start command: ${(error as Error).message}`, isError: true });
      });
      child.on("close", finish);
    });
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
