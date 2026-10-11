#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  JsonlSession,
  NullSession,
  defaultSessionDir,
  forkSession,
  latestSession,
  listSessions,
  openSession,
  resolveSessionPath,
  type Message,
  type Session,
} from "pi-agent";
import { createModelClient } from "pi-ai";
import { helpText, parseArgs, UsageError, type CliOptions } from "./args.js";
import { isCommand, runCommand } from "./commands.js";
import { loadExtensions } from "./loadExtensions.js";
import { readSettings, resolveProviderAndModel } from "./settings.js";
import { jsonView } from "./views/json.js";
import { printView } from "./views/print.js";
import { startTui } from "./views/tui.js";

async function main(argv: string[]): Promise<number> {
  if (isCommand(argv[0])) return runCommand(argv);

  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(helpText);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const sessionDir = options.sessionDir
    ? resolve(options.cwd, options.sessionDir)
    : defaultSessionDir(options.cwd);

  if (options.listSessions) {
    await printSessions(sessionDir);
    return 0;
  }

  // No prompt on a terminal means an interactive session.
  const interactive = options.tui || (options.prompt === undefined && options.mode === "print" && process.stdin.isTTY === true);
  const prompt = interactive ? undefined : options.prompt ?? (await readStdin());
  if (!interactive && (!prompt || prompt.trim() === "")) {
    process.stderr.write(`mya: no prompt. Try: mya -p "read README.md and summarize it"\n`);
    return 2;
  }

  const cwd = resolve(options.cwd);
  // A name is all the CLI knows. The provider package owns the rest.
  const resolved = resolveProviderAndModel(options, readSettings());
  const model = createModelClient(resolved.provider, resolved.model ? { model: resolved.model } : {});
  // Viz goes last so it sees the context after every other extension has shaped it.
  const extensions = await loadExtensions(options.viz ? [...options.extensions, "pi-viz"] : options.extensions, { cwd });

  const { session, messages } = await chooseSession(options, cwd, sessionDir);

  const agent = new Agent({
    model,
    ...(resolved.model ? { modelName: resolved.model } : {}),
    cwd,
    extensions,
    session,
    ...(messages.length > 0 ? { messages } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
  });

  if (interactive) {
    // The TUI subscribes to the same events and drives no loop of its own.
    await startTui({ agent });
    return 0;
  }

  const write = (text: string) => process.stdout.write(text);
  agent.subscribe(
    options.mode === "json"
      ? jsonView({ write })
      : printView({ write, color: process.stdout.isTTY === true }),
  );

  const onSignal = () => agent.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let code: number;
  try {
    const result = await agent.run(prompt);
    code = result.reason === "error" ? 1 : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const vizUrl = await (extensions.find((extension) => extension.name === "viz") as { url?: Promise<string> } | undefined)
    ?.url?.catch(() => undefined);
  if (vizUrl) {
    notice(`the visualization stays up at ${vizUrl}. Press Enter or Ctrl+C to exit.`);
    await waitForExit();
  }
  return code;
}

/** Keeps a print-mode run's viz page alive until the user is done looking. */
function waitForExit(): Promise<void> {
  return new Promise((resolve) => {
    // The viz server is unref'd so it never blocks a normal exit; this holds the process open.
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

/**
 * A new session, the most recent one, a named one, or a fork of one. A resumed
 * session keeps appending to its own file, so the next model call sees the
 * earlier tool results.
 */
async function chooseSession(
  options: CliOptions,
  cwd: string,
  sessionDir: string,
): Promise<{ session: Session; messages: Message[] }> {
  if (options.fork) {
    const source = await resolveSessionPath(sessionDir, options.fork);
    const fork = await forkSession({
      source,
      ...(options.at === undefined ? {} : { at: options.at }),
      ...(options.sessionFile ? { file: resolve(cwd, options.sessionFile) } : { dir: sessionDir }),
    });
    notice(
      `forked ${fork.source} before user message ${fork.atUserMessage}: ${fork.copied} messages copied to ${fork.file}`,
    );
    const opened = await openSession(fork.file);
    return { session: opened.session, messages: opened.messages };
  }

  if (options.continueSession || options.resume) {
    const file = options.resume
      ? await resolveSessionPath(sessionDir, options.resume)
      : await latestSession(sessionDir);
    const opened = await openSession(file);
    notice(`resumed ${file}: ${opened.messages.length} messages`);
    return { session: opened.session, messages: opened.messages };
  }

  if (options.noSession) return { session: new NullSession(), messages: [] };

  return {
    session: new JsonlSession(
      options.sessionFile ? { file: resolve(cwd, options.sessionFile) } : { dir: sessionDir },
    ),
    messages: [],
  };
}

async function printSessions(dir: string): Promise<void> {
  const sessions = await listSessions(dir);
  if (sessions.length === 0) {
    process.stdout.write(`no sessions in ${dir}\n`);
    return;
  }
  for (const session of sessions) {
    const when = new Date(session.updatedAt).toISOString().replace("T", " ").slice(0, 19);
    const prompt = session.firstPrompt?.replace(/\s+/g, " ").slice(0, 60) ?? "";
    process.stdout.write(`${session.id}  ${when}  ${String(session.messages).padStart(3)} msgs  ${prompt}\n`);
  }
}

/** Session notices go to stderr so JSON mode stays one event per line. */
function notice(text: string): void {
  process.stderr.write(`mya: ${text}\n`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function version(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`mya: ${error.message}\n\n${helpText}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`mya: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
