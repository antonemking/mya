import { spawn } from "node:child_process";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { defaultSessionDir, eventsFileFor, readEvents, resolveSessionPath, SessionError } from "pi-agent";
import {
  authStatus,
  defaultAuthFile,
  isOAuthProvider,
  isProviderName,
  login,
  logout,
  oauthProviders,
  providerNames,
  type AuthInteraction,
} from "pi-ai";
import { readSettings, resolveProviderAndModel, settingKeys, settingsFile, writeSettings, type SettingKey } from "./settings.js";
import { viz } from "pi-viz";
import { jsonView } from "./views/json.js";
import { printView } from "./views/print.js";

export const commandNames = ["login", "logout", "status", "config", "replay"] as const;

export function isCommand(word: string | undefined): word is (typeof commandNames)[number] {
  return word !== undefined && (commandNames as readonly string[]).includes(word);
}

const out = (text: string) => void process.stdout.write(`${text}\n`);
const fail = (text: string) => void process.stderr.write(`mya: ${text}\n`);

export async function runCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "login":
      return runLogin(rest);
    case "logout":
      return runLogout(rest);
    case "status":
      return runStatus();
    case "config":
      return runConfig(rest);
    case "replay":
      return runReplay(rest);
    default:
      return 2;
  }
}

async function runLogin(args: string[]): Promise<number> {
  const device = args.includes("--device");
  const provider = args.find((arg) => !arg.startsWith("-")) ?? "openai-codex";
  if (!isOAuthProvider(provider)) {
    fail(`${provider} does not use a subscription login. Subscription providers: ${oauthProviders.join(", ")}`);
    fail("API-key providers read their key from the environment instead.");
    return 2;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const interaction: AuthInteraction = {
    showUrl(url) {
      out("Sign in to ChatGPT in your browser to finish.");
      out(`If it does not open, visit:\n\n  ${url}\n`);
      openBrowser(url);
    },
    showDeviceCode(code, uri) {
      out(`Open ${uri} and enter this code:\n\n  ${code}\n`);
      out("Waiting for you to approve…");
    },
    ...(process.stdin.isTTY ? { askForCode } : {}),
    signal: controller.signal,
  };

  try {
    const credential = await login(provider, interaction, { method: device ? "device" : "browser" });
    const who = credential.email ?? credential.accountId ?? "your account";
    out(`\nSigned in to ${provider} as ${who}.`);
    out(`Credentials saved to ${defaultAuthFile()} (owner-only).`);

    const settings = readSettings();
    if (!settings.provider) {
      writeSettings({ ...settings, provider });
      out(`Default provider is now ${provider}. Change it with \`mya config set provider <name>\`.`);
    } else if (settings.provider !== provider) {
      out(`Your default provider is still ${settings.provider}. Use \`--provider ${provider}\` or \`mya config set provider ${provider}\`.`);
    }
    return 0;
  } catch (error) {
    fail(`login failed: ${(error as Error).message}`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function askForCode(signal: AbortSignal): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("Or paste the redirect URL here if the browser cannot reach this machine:\n> ", { signal });
  } finally {
    rl.close();
  }
}

function openBrowser(url: string): void {
  if (process.env.MYA_NO_BROWSER) return;
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
    // The URL is printed; that is enough.
  }
}

function runLogout(args: string[]): number {
  const provider = args.find((arg) => !arg.startsWith("-")) ?? "openai-codex";
  const removed = logout(provider);
  out(removed ? `Signed out of ${provider}.` : `No login stored for ${provider}.`);

  const settings = readSettings();
  if (settings.provider === provider) {
    const { provider: _dropped, ...rest } = settings;
    writeSettings(rest);
    out(`Cleared ${provider} as the default provider.`);
  }
  return 0;
}

function runStatus(): number {
  const settings = readSettings();
  const resolved = resolveProviderAndModel({}, settings);

  out("Defaults");
  out(`  provider  ${resolved.provider}  (from ${resolved.providerSource})`);
  out(`  model     ${resolved.model ?? "provider default"}${resolved.modelSource ? `  (from ${resolved.modelSource})` : ""}`);
  out(`  settings  ${settingsFile()}`);

  out("\nSubscription logins");
  const logins = authStatus();
  if (logins.length === 0) out("  none. Run `mya login` to sign in to openai-codex.");
  for (const entry of logins) {
    const who = entry.email ?? entry.accountId ?? "unknown account";
    const minutes = Math.round((entry.expires - Date.now()) / 60000);
    const state = minutes > 0 ? `token valid ${formatDuration(minutes)}` : "token expired; refreshes on next use";
    out(`  ${entry.provider.padEnd(14)} ${who}  ·  ${state}`);
  }

  out("\nAPI keys (environment)");
  out(`  anthropic      ${process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY set" : "ANTHROPIC_API_KEY not set"}`);
  out(`  openai         ${process.env.OPENAI_API_KEY ? "OPENAI_API_KEY set" : "OPENAI_API_KEY not set"}`);
  return 0;
}

function runConfig(args: string[]): number {
  const [action, key, value] = args;
  const settings = readSettings();

  if (action === undefined) {
    out(JSON.stringify(settings, null, 2));
    return 0;
  }
  if (!key || !(settingKeys as readonly string[]).includes(key)) {
    fail(`config key must be one of: ${settingKeys.join(", ")}`);
    return 2;
  }
  const name = key as SettingKey;

  if (action === "set") {
    if (!value) {
      fail(`config set ${name} needs a value`);
      return 2;
    }
    if (name === "provider" && !isProviderName(value)) {
      fail(`unknown provider ${value}. Known providers: ${providerNames.join(", ")}`);
      return 2;
    }
    writeSettings({ ...settings, [name]: value });
    out(`${name} = ${value}`);
    return 0;
  }
  if (action === "unset") {
    const { [name]: _dropped, ...rest } = settings;
    writeSettings(rest);
    out(`${name} cleared`);
    return 0;
  }
  fail("usage: mya config [set <key> <value> | unset <key>]");
  return 2;
}

/**
 * Print a finished run from its event log. The model is not called and tools
 * are not run again. `--json` writes the recorded events, bodies included.
 */
async function runReplay(args: string[]): Promise<number> {
  let mode: "print" | "json" = "print";
  let cwd = process.cwd();
  let showViz = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json" || arg === "--mode" && args[i + 1] === "json") {
      if (arg === "--mode") i += 1;
      mode = "json";
      continue;
    }
    if (arg === "--mode" && args[i + 1] === "print") {
      i += 1;
      continue;
    }
    if (arg === "--viz") {
      showViz = true;
      continue;
    }
    if (arg === "-C" || arg === "--cwd") {
      const value = args[++i];
      if (!value) {
        fail("replay -C needs a directory");
        return 2;
      }
      cwd = resolve(value);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`unknown flag: ${arg}`);
      return 2;
    }
    positional.push(arg);
  }

  const ref = positional[0];
  if (!ref) {
    fail("replay needs a session id. Try: mya replay <id>");
    return 2;
  }

  try {
    const sessionFile = await resolveSessionPath(defaultSessionDir(cwd), ref);
    const events = await readEvents(eventsFileFor(sessionFile));
    const write = (text: string) => {
      process.stdout.write(text);
    };
    const view =
      mode === "json" ? jsonView({ write }) : printView({ write, color: process.stdout.isTTY === true });
    for (const event of events) view(event);

    if (showViz) {
      const page = viz({ log: (text) => fail(text) });
      const url = await page.url;
      page.load(events);
      fail(`the visualization stays up at ${url}. Press Enter or Ctrl+C to exit.`);
      await waitForExit();
      page.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof SessionError) {
      fail(error.message);
      return 1;
    }
    throw error;
  }
}

function waitForExit(): Promise<void> {
  return new Promise((resolve) => {
    const hold = setInterval(() => {}, 1 << 30);
    const done = () => {
      clearInterval(hold);
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      process.stdin.pause();
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.once("data", done);
    }
  });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
