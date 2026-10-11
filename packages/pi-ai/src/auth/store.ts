import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Subscription credentials live here, inside the provider package. The file
 * is owner-only; nothing else in the harness reads it or learns its shape.
 */
export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expires: number;
  accountId?: string;
  email?: string;
}

export type Credential = OAuthCredential;

type StoreFile = Record<string, Credential>;

export function myaHome(): string {
  return process.env.MYA_HOME || join(homedir(), ".mya");
}

export function defaultAuthFile(): string {
  return process.env.MYA_AUTH_FILE || join(myaHome(), "auth.json");
}

export class CredentialStore {
  constructor(readonly file: string = defaultAuthFile()) {}

  get(provider: string): Credential | undefined {
    return this.#read()[provider];
  }

  set(provider: string, credential: Credential): void {
    const all = this.#read();
    all[provider] = credential;
    this.#write(all);
  }

  delete(provider: string): boolean {
    const all = this.#read();
    if (!(provider in all)) return false;
    delete all[provider];
    this.#write(all);
    return true;
  }

  list(): Array<{ provider: string; credential: Credential }> {
    return Object.entries(this.#read()).map(([provider, credential]) => ({ provider, credential }));
  }

  #read(): StoreFile {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    } catch {
      throw new Error(`credential file ${this.file} is not valid JSON`);
    }
  }

  #write(all: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}
