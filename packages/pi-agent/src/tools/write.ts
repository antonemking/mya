import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath, requireString, resolveInsideCwd } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

export const writeTool: Tool = {
  name: "write",
  description:
    "Write a UTF-8 text file inside the working directory, creating parent directories as needed. Replaces the whole file; use edit for a targeted change.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      content: { type: "string", description: "Full contents of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const target = resolveInsideCwd(context.cwd, requireString(args, "path"));
    const content = requireString(args, "content");

    const existing = await stat(target).catch(() => undefined);
    if (existing?.isDirectory()) {
      throw new ToolError(`${displayPath(context.cwd, target)} is a directory`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");

    const bytes = Buffer.byteLength(content, "utf8");
    const verb = existing ? "overwrote" : "wrote";
    return { output: `${verb} ${displayPath(context.cwd, target)} (${bytes} bytes)` };
  },
};
