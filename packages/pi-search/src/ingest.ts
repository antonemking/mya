import { LiteParse } from "@llamaindex/liteparse";
import type { Chunk } from "./corpus.js";

export interface ParsedPage {
  page: number;
  markdown: string;
}

export interface ParsedDocument {
  id: string;
  title: string;
  source: string;
  pages: ParsedPage[];
}

let parser: LiteParse | undefined;

/** LiteParse's Markdown, one entry per page. OCR is off: these are born-digital PDFs. */
export async function parseDocument(source: string, meta: { id: string; title: string }): Promise<ParsedDocument> {
  parser ??= new LiteParse({ outputFormat: "markdown", ocrEnabled: false, imageMode: "off", quiet: true });
  const result = await parser.parse(source);
  return {
    id: meta.id,
    title: meta.title,
    source,
    pages: result.pages.map((page) => ({ page: page.pageNum, markdown: page.markdown })),
  };
}

export interface ChunkOptions {
  /** A chunk closes at the first block boundary past this many words. */
  targetWords?: number;
  /** A single block longer than this is cut into pieces of this size. */
  maxWords?: number;
}

/**
 * Packs Markdown blocks into passages of roughly `targetWords`. A heading
 * closes the running chunk once it has some substance, and becomes the
 * section of the chunks after it.
 */
export function chunkDocument(document: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const targetWords = options.targetWords ?? 200;
  const maxWords = options.maxWords ?? 400;
  const chunks: Chunk[] = [];
  let section: string | undefined;
  let blocks: string[] = [];
  let words = 0;
  let page = 1;

  const flush = () => {
    if (words === 0) return;
    chunks.push({
      id: `${document.id}#${chunks.length}`,
      doc: document.id,
      title: document.title,
      ...(section ? { section } : {}),
      page,
      text: blocks.join("\n\n"),
    });
    blocks = [];
    words = 0;
  };

  for (const { page: pageNum, markdown } of document.pages) {
    for (const block of markdown.split(/\n\s*\n/)) {
      const text = block.trim();
      if (text === "" || /^!\[[^\]]*\]\([^)]*\)$/.test(text)) continue;

      const heading = /^#{1,6}\s+(.+)$/.exec(text);
      if (heading && !text.includes("\n")) {
        if (words >= targetWords / 4) flush();
        section = heading[1]!.trim();
        continue;
      }

      const blockWords = text.split(/\s+/);
      const pieces =
        blockWords.length <= maxWords
          ? [{ text, words: blockWords.length }]
          : Array.from({ length: Math.ceil(blockWords.length / maxWords) }, (_, i) => {
              const slice = blockWords.slice(i * maxWords, (i + 1) * maxWords);
              return { text: slice.join(" "), words: slice.length };
            });
      for (const piece of pieces) {
        if (words === 0) page = pageNum;
        blocks.push(piece.text);
        words += piece.words;
        if (words >= targetWords) flush();
      }
    }
  }
  flush();
  return chunks;
}
