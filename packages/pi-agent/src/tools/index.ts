import { bashTool } from "./bash.js";
import { checkTool } from "./check.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import type { Tool } from "./types.js";

export { bashTool, checkTool, editTool, readTool, writeTool };
export * from "./types.js";
export { displayPath, optionalBoolean, optionalNumber, requireString, resolveInsideCwd } from "./paths.js";

/** The tools core ships. Extensions add more; they do not live in here. */
export function coreTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, checkTool];
}
