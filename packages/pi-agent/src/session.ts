import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentEvent } from "./events.js";
import type { Message } from "./transcript.js";

/** One record per message, appended as the run goes. */
export interface SessionRecord {
  seq: number;
  at: number;
  message: Message;
}

export interface Session {
  readonly id: string;
  readonly file?: string;
  append(message: Message): Promise<void>;
}

/** Used when a run should not touch the disk. */
export class NullSession implements Session {
  constructor(readonly id: string = newSessionId()) {}
  async append(): Promise<void> {}
}

export class JsonlSession implements Session {
  readonly id: string;
  readonly file: string;
  #seq: number;
  #queue: Promise<void> = Promise.resolve();
  #ready: Promise<void>;

  constructor(options: { id?: string; file?: string; dir?: string; startSeq?: number } = {}) {
    this.id = options.id ?? (options.file ? sessionIdOf(options.file) : newSessionId());
    this.file = options.file
      ? resolve(options.file)
      : join(resolve(options.dir ?? defaultSessionDir()), `${this.id}.jsonl`);
    this.#seq = options.startSeq ?? 0;
    this.#ready = mkdir(dirname(this.file), { recursive: true }).then(() => undefined);
  }

  append(message: Message): Promise<void> {
    const record: SessionRecord = { seq: this.#seq++, at: Date.now(), message };
    this.#queue = this.#queue
      .then(() => this.#ready)
      .then(() => appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8"));
    return this.#queue;
  }

  /** Wait until every appended record is on disk. */
  flush(): Promise<void> {
    return this.#queue;
  }
}

/**
 * One agent event per line, beside the session file. The session JSONL stays
 * the transcript; this file is the trace, including raw provider bodies.
 */
export class JsonlEventLog {
  readonly file: string;
  #queue: Promise<void> = Promise.resolve();
  #ready: Promise<void>;

  constructor(file: string) {
    this.file = resolve(file);
    this.#ready = mkdir(dirname(this.file), { recursive: true }).then(() => undefined);
  }

  append(event: AgentEvent): Promise<void> {
    this.#queue = this.#queue
      .then(() => this.#ready)
      .then(() => appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8"));
    return this.#queue;
  }

  flush(): Promise<void> {
    return this.#queue;
  }
}

/** `id.jsonl` keeps messages. `id.events.jsonl` keeps the trace. */
export function eventsFileFor(sessionFile: string): string {
  const file = resolve(sessionFile);
  return file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}.events.jsonl` : `${file}.events.jsonl`;
}

export function isEventsFile(file: string): boolean {
  return file.endsWith(".events.jsonl");
}

export async function readEvents(file: string): Promise<AgentEvent[]> {
  const text = await readFile(file, "utf8").catch(() => {
    throw new SessionError(`no event log at ${file}`);
  });
  const events: AgentEvent[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch {
      throw new SessionError(`${file} line ${index + 1} is not valid JSON`);
    }
  }
  return events;
}

export function defaultSessionDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".mya", "sessions");
}

export function newSessionId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function sessionIdOf(file: string): string {
  return basename(file, ".jsonl");
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export async function readRecords(file: string): Promise<SessionRecord[]> {
  const text = await readFile(file, "utf8").catch(() => {
    throw new SessionError(`no session file at ${file}`);
  });
  const records: SessionRecord[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      throw new SessionError(`${file} line ${index + 1} is not valid JSON`);
    }
  }
  return records;
}

export async function readTranscript(file: string): Promise<Message[]> {
  return (await readRecords(file)).map((record) => record.message);
}

/** Reopen a session so new messages append to the same file. */
export async function openSession(file: string): Promise<{ session: JsonlSession; messages: Message[] }> {
  const records = await readRecords(file);
  const session = new JsonlSession({ file, startSeq: records.length });
  return { session, messages: records.map((record) => record.message) };
}

export interface SessionInfo {
  id: string;
  file: string;
  updatedAt: number;
  messages: number;
  /** The first thing the user asked, for picking a session out of a list. */
  firstPrompt?: string;
}

/** Newest first. */
export async function listSessions(dir: string): Promise<SessionInfo[]> {
  const entries = await readdir(resolve(dir)).catch(() => [] as string[]);
  const infos: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl") || isEventsFile(entry)) continue;
    const file = join(resolve(dir), entry);
    const [info, records] = await Promise.all([stat(file), readRecords(file).catch(() => [])]);
    const first = records.find((record) => record.message.role === "user");
    infos.push({
      id: sessionIdOf(file),
      file,
      updatedAt: info.mtimeMs,
      messages: records.length,
      ...(first && first.message.role === "user" ? { firstPrompt: first.message.content } : {}),
    });
  }
  return infos.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function latestSession(dir: string): Promise<string> {
  const sessions = await listSessions(dir);
  const newest = sessions[0];
  if (!newest) throw new SessionError(`no sessions in ${resolve(dir)}`);
  return newest.file;
}

/** Accepts a path, a session id, or a unique id prefix. */
export async function resolveSessionPath(dir: string, ref: string): Promise<string> {
  if (ref.endsWith(".jsonl") || ref.includes("/") || isAbsolute(ref)) {
    const file = resolve(ref);
    await stat(file).catch(() => {
      throw new SessionError(`no session file at ${file}`);
    });
    return file;
  }
  const sessions = await listSessions(dir);
  const exact = sessions.find((session) => session.id === ref);
  if (exact) return exact.file;
  const matches = sessions.filter((session) => session.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!.file;
  if (matches.length > 1) throw new SessionError(`session id ${ref} is ambiguous (${matches.length} matches)`);
  throw new SessionError(`no session ${ref} in ${resolve(dir)}`);
}

export interface ForkOptions {
  source: string;
  /** 1-based index among the user messages. Defaults to the last one. */
  at?: number;
  dir?: string;
  file?: string;
  id?: string;
}

export interface ForkResult {
  file: string;
  id: string;
  source: string;
  /** Which user message the fork rewinds to. */
  atUserMessage: number;
  /** How many records the fork copied. */
  copied: number;
}

/**
 * Copy the path up to an earlier user message into a new file. The fork stops
 * just before that message, so the next prompt takes a different branch. The
 * source file is only read.
 */
export async function forkSession(options: ForkOptions): Promise<ForkResult> {
  const source = resolve(options.source);
  const records = await readRecords(source);
  const userIndexes = records
    .map((record, index) => (record.message.role === "user" ? index : -1))
    .filter((index) => index !== -1);

  if (userIndexes.length === 0) throw new SessionError(`${source} has no user message to fork at`);

  const at = options.at ?? userIndexes.length;
  if (!Number.isInteger(at) || at < 1 || at > userIndexes.length) {
    throw new SessionError(`${source} has ${userIndexes.length} user messages; cannot fork at ${at}`);
  }

  const cut = userIndexes[at - 1]!;
  const kept = records.slice(0, cut).map((record, seq) => ({ ...record, seq }));

  const id = options.id ?? newSessionId();
  const file = options.file
    ? resolve(options.file)
    : join(resolve(options.dir ?? dirname(source)), `${id}.jsonl`);

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, kept.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");

  return { file, id: sessionIdOf(file), source, atUserMessage: at, copied: kept.length };
}
