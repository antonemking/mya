/**
 * Prints the acceptance trace for the first slice.
 *
 * With ANTHROPIC_API_KEY set, in the environment or in a .env file at the repo
 * root, it calls Anthropic. Without one it points the real CLI at the SSE
 * fixture in packages/pi/test, so the loop, the tools, the decoder, and the
 * views are all real code and only the model is scripted.
 *
 *   node scripts/trace.mjs
 *   node scripts/trace.mjs --mode json
 *   node scripts/trace.mjs --tui     same prompt, typed into the TUI
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAnthropic } from "../packages/pi/test/fakeAnthropic.js";
import { startFakeOpenAI } from "../packages/pi/test/fakeOpenAI.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "pi", "dist", "cli.js");
const args = process.argv.slice(2);

// The .env file is a convenience for this dev script. Core reads the
// environment and nothing else.
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env, or an unreadable one. The environment still decides.
}

const providerFlag = args.indexOf("--provider");
const provider = providerFlag === -1 ? "anthropic" : args[providerFlag + 1];
const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
const live = Boolean(process.env[keyName]);

const server = live ? undefined : await (provider === "openai" ? startFakeOpenAI() : startFakeAnthropic());
const env = { ...process.env };
if (!live) {
  env[keyName] = "fixture-key";
  env[provider === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"] = server.url;
  process.stderr.write(`no ${keyName}, using the ${provider} SSE fixture as the provider\n\n`);
}

const PROMPT = "read README.md and summarize it";
const tui = args.includes("--tui");
const passthrough = args.filter((arg) => arg !== "--tui");
const cliArgs = tui
  ? [cli, "--tui", "--no-session", ...passthrough]
  : [cli, "-p", PROMPT, "--no-session", ...passthrough];

const child = spawn(process.execPath, cliArgs, {
  cwd: root,
  env,
  stdio: tui ? ["pipe", "inherit", "inherit"] : "inherit",
});

if (tui) {
  // Type the same prompt the print-mode trace uses, then leave.
  child.stdin.write(`${PROMPT}\n`);
  child.stdin.end();
}

child.on("close", async (code) => {
  await server?.close();
  process.exitCode = code ?? 0;
});
