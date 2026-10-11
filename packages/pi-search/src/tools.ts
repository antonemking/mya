import { optionalBoolean, optionalNumber, requireString, ToolError, type Tool } from "pi-agent";
import type { Chunk, SearchCorpus } from "./corpus.js";
import { grep } from "./grep.js";

const MAX_LIMIT = 30;

/** `list_documents`, `search`, `grep`, and `read_chunk` over one corpus. Every result names chunk ids. */
export function searchTools(corpus: SearchCorpus): Tool[] {
  return [listDocumentsTool(corpus), searchTool(corpus), grepTool(corpus), readChunkTool(corpus)];
}

function listDocumentsTool(corpus: SearchCorpus): Tool {
  return {
    name: "list_documents",
    description: "List the documents in the search corpus: id, title, pages, and chunk count.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute() {
      if (corpus.documents.length === 0) return { output: "(no documents)" };
      return {
        output: corpus.documents.map((d) => `${d.id}\t${d.title}\t${d.pages}p\t${d.chunks} chunks`).join("\n"),
      };
    },
  };
}

function searchTool(corpus: SearchCorpus): Tool {
  return {
    name: "search",
    description:
      "BM25 keyword search over document chunks. Matches words, not meaning: use the terms the text itself would use. " +
      "Returns chunk ids, scores, and a snippet. Pass `doc` to search one document.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match." },
        doc: { type: "string", description: "Only search this document id." },
        limit: { type: "number", description: `Results to return, 1-${MAX_LIMIT}. Defaults to 10.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute(args) {
      const query = requireString(args, "query");
      const doc = optionalString(args, "doc");
      const limit = clampLimit(optionalNumber(args, "limit") ?? 10);
      const hits = corpus.bm25(query, { limit, ...(doc ? { doc } : {}) });
      if (hits.length === 0) return { output: "no matches" };
      return {
        output: hits
          .map((hit) => `${header(corpus.chunk(hit.id)!)} score=${hit.score.toFixed(2)}\n  ${snippet(corpus.chunk(hit.id)!.text)}`)
          .join("\n"),
      };
    },
  };
}

function grepTool(corpus: SearchCorpus): Tool {
  return {
    name: "grep",
    description:
      "Find chunks containing an exact string, or a regular expression with regex=true. Case-insensitive by default. " +
      "Good for names, numbers, acronyms, and exact phrases. Pass `doc` to search one document.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        regex: { type: "boolean", description: "Treat pattern as a JavaScript regular expression." },
        case_sensitive: { type: "boolean" },
        doc: { type: "string", description: "Only search this document id." },
        limit: { type: "number", description: `Chunks to return, 1-${MAX_LIMIT}. Defaults to 20.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute(args) {
      const pattern = requireString(args, "pattern");
      const doc = optionalString(args, "doc");
      let hits;
      try {
        hits = grep(corpus.chunks, pattern, {
          regex: optionalBoolean(args, "regex") ?? false,
          caseSensitive: optionalBoolean(args, "case_sensitive") ?? false,
          limit: clampLimit(optionalNumber(args, "limit") ?? 20),
          ...(doc ? { doc } : {}),
        });
      } catch (error) {
        throw new ToolError(`bad pattern: ${(error as Error).message}`);
      }
      if (hits.length === 0) return { output: "no matches" };
      return {
        output: hits.map((hit) => `${header(corpus.chunk(hit.id)!)} matches=${hit.matches}\n  ${hit.snippet}`).join("\n"),
      };
    },
  };
}

function readChunkTool(corpus: SearchCorpus): Tool {
  return {
    name: "read_chunk",
    description: "Read the full text of one or more chunks by id.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: "Chunk ids, e.g. 1912.01214#3." } },
      required: ["ids"],
      additionalProperties: false,
    },
    execute(args) {
      const ids = (args as { ids?: unknown }).ids;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw new ToolError("ids must be an array of chunk id strings");
      }
      return {
        output: (ids as string[])
          .map((id) => {
            const chunk = corpus.chunk(id);
            return chunk ? `${header(chunk)}\n${chunk.text}` : `[${id}] no such chunk`;
          })
          .join("\n\n"),
      };
    },
  };
}

function header(chunk: Chunk): string {
  return `[${chunk.id}] ${chunk.title}${chunk.section ? ` › ${chunk.section}` : ""} (p.${chunk.page})`;
}

function snippet(text: string, length = 240): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`${key} must be a string`);
  return value;
}
