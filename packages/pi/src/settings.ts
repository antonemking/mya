import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { myaHome } from "pi-ai";

/** User defaults. Names only: no keys, no tokens, no URLs. */
export interface Settings {
  provider?: string;
  model?: string;
}

export const settingKeys = ["provider", "model"] as const;
export type SettingKey = (typeof settingKeys)[number];

export function settingsFile(): string {
  return process.env.MYA_SETTINGS_FILE || join(myaHome(), "settings.json");
}

export function readSettings(): Settings {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Settings;
  } catch {
    throw new Error(`settings file ${file} is not valid JSON`);
  }
}

export function writeSettings(settings: Settings): void {
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export interface Resolved {
  provider: string;
  providerSource: "flag" | "env" | "config" | "default";
  model?: string;
  modelSource?: "flag" | "env" | "config";
}

/** Flag, then environment, then `mya config`, then the built-in default. */
export function resolveProviderAndModel(flags: { provider?: string; model?: string }, settings: Settings): Resolved {
  const envProvider = process.env.MYA_PROVIDER || process.env.PI_PROVIDER || undefined;
  const [provider, providerSource]: [string, Resolved["providerSource"]] = flags.provider
    ? [flags.provider, "flag"]
    : envProvider
      ? [envProvider, "env"]
      : settings.provider
        ? [settings.provider, "config"]
        : ["anthropic", "default"];

  const envModel = process.env.MYA_MODEL || process.env.PI_MODEL || undefined;
  // A configured model belongs to the configured provider; never hand it to another.
  const configModel = settings.model && settings.provider === provider ? settings.model : undefined;
  const resolved: Resolved = { provider, providerSource };
  if (flags.model) Object.assign(resolved, { model: flags.model, modelSource: "flag" });
  else if (envModel) Object.assign(resolved, { model: envModel, modelSource: "env" });
  else if (configModel) Object.assign(resolved, { model: configModel, modelSource: "config" });
  return resolved;
}
