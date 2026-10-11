import { isAbsolute, relative, resolve } from "node:path";
import { ToolError } from "./types.js";

/**
 * `read`, `write`, and `edit` stay inside the working directory. `bash` does
 * not go through here: it runs as the user with cwd as its cwd.
 */
export function resolveInsideCwd(cwd: string, path: unknown): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ToolError("path must be a non-empty string");
  }
  const root = resolve(cwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, target);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep()}`) || isAbsolute(rel))) {
    throw new ToolError(`path escapes the working directory: ${path}`);
  }
  return target;
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(resolve(cwd), absolute);
  return rel === "" ? absolute : rel;
}

export function requireString(args: unknown, key: string): string {
  const record = args as Record<string, unknown> | null;
  const value = record?.[key];
  if (typeof value !== "string") {
    throw new ToolError(`${key} must be a string`);
  }
  return value;
}

export function optionalNumber(args: unknown, key: string): number | undefined {
  const record = args as Record<string, unknown> | null;
  const value = record?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(`${key} must be a number`);
  }
  return value;
}

export function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const record = args as Record<string, unknown> | null;
  const value = record?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolError(`${key} must be a boolean`);
  }
  return value;
}
