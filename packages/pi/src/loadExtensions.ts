import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { Extension } from "pi-agent";

export interface ExtensionLoadContext {
  cwd: string;
}

/**
 * An extension module exports an Extension, or a factory that returns one,
 * as `default` or as `extension`.
 */
export async function loadExtensions(specifiers: string[], context: ExtensionLoadContext): Promise<Extension[]> {
  const extensions: Extension[] = [];
  for (const specifier of specifiers) {
    const url = toUrl(specifier, context.cwd);
    const module = (await import(url)) as Record<string, unknown>;
    const candidate = module["default"] ?? module["extension"];
    const value = typeof candidate === "function" ? await (candidate as (c: ExtensionLoadContext) => unknown)(context) : candidate;
    if (!isExtension(value)) {
      throw new Error(`${specifier} does not export an extension`);
    }
    extensions.push(value);
  }
  return extensions;
}

function toUrl(specifier: string, cwd: string): string {
  if (specifier.startsWith("file://")) return specifier;
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(cwd, specifier)).href;
  }
  return specifier;
}

function isExtension(value: unknown): value is Extension {
  return typeof value === "object" && value !== null && typeof (value as Extension).name === "string";
}
