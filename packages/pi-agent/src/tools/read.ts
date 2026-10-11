import { readFile, stat } from "node:fs/promises";
import { displayPath, optionalNumber, requireString, resolveInsideCwd } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

const MAX_BYTES = 400_000;
const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

export const readTool: Tool = {
  name: "read",
  description:
    "Read a UTF-8 text file inside the working directory. Returns the contents with 1-based line numbers. Use offset and limit for long files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      offset: { type: "number", description: "First line to return, 1-based. Defaults to 1." },
      limit: { type: "number", description: `Maximum number of lines. Defaults to ${DEFAULT_LIMIT}.` },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const target = resolveInsideCwd(context.cwd, requireString(args, "path"));
    const offset = Math.max(1, Math.trunc(optionalNumber(args, "offset") ?? 1));
    const limit = Math.max(1, Math.trunc(optionalNumber(args, "limit") ?? DEFAULT_LIMIT));

    const info = await stat(target).catch(() => undefined);
    if (!info) throw new ToolError(`no such file: ${displayPath(context.cwd, target)}`);
    if (info.isDirectory()) throw new ToolError(`${displayPath(context.cwd, target)} is a directory`);
    if (info.size > MAX_BYTES) {
      throw new ToolError(`file is ${info.size} bytes, over the ${MAX_BYTES} byte read limit`);
    }

    const buffer = await readFile(target);
    if (buffer.includes(0)) {
      throw new ToolError(`${displayPath(context.cwd, target)} looks binary`);
    }

    const lines = buffer.toString("utf8").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      return { output: `${displayPath(context.cwd, target)} has ${lines.length} lines; offset ${offset} is past the end.` };
    }

    const width = String(offset + slice.length - 1).length;
    const body = slice
      .map((line, i) => {
        const clipped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (${line.length} chars)` : line;
        return `${String(offset + i).padStart(width, " ")}\t${clipped}`;
      })
      .join("\n");

    const shown = offset - 1 + slice.length;
    const footer = shown < lines.length ? `\n\n(showing lines ${offset}-${shown} of ${lines.length})` : "";
    return { output: `${body}${footer}` };
  },
};
