import { readFile, writeFile } from "node:fs/promises";
import { displayPath, optionalBoolean, requireString, resolveInsideCwd } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file inside the working directory. old_string must appear exactly once unless replace_all is true. Include surrounding context to make it unique.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      old_string: { type: "string", description: "Exact text to replace, including whitespace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const target = resolveInsideCwd(context.cwd, requireString(args, "path"));
    const oldString = requireString(args, "old_string");
    const newString = requireString(args, "new_string");
    const replaceAll = optionalBoolean(args, "replace_all") ?? false;

    if (oldString === "") throw new ToolError("old_string must not be empty");
    if (oldString === newString) throw new ToolError("old_string and new_string are identical");

    const before = await readFile(target, "utf8").catch(() => {
      throw new ToolError(`no such file: ${displayPath(context.cwd, target)}`);
    });

    const occurrences = countOccurrences(before, oldString);
    if (occurrences === 0) {
      throw new ToolError(`old_string not found in ${displayPath(context.cwd, target)}`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${displayPath(context.cwd, target)}; add context or set replace_all`,
      );
    }

    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    await writeFile(target, after, "utf8");

    const replaced = replaceAll ? occurrences : 1;
    return {
      output: `edited ${displayPath(context.cwd, target)} (${replaced} replacement${replaced === 1 ? "" : "s"})`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
