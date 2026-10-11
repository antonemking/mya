/**
 * Dev runner: loads the gitignored .env, then forwards every argument to the
 * CLI. Handy for session work, where the prompt changes on each command.
 *
 *   node scripts/pi.mjs -p "read README.md and summarize it"
 *   node scripts/pi.mjs -c -p "and how many packages?"
 *   node scripts/pi.mjs --fork <id> --at 2 -p "take a different branch"
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "pi", "dist", "cli.js");

try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env. The environment still decides.
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
child.on("close", (code) => {
  process.exitCode = code ?? 0;
});
