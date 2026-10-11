import type { StreamEvent } from "./types.js";

/** Minimal server-sent-events reader over a fetch body. */
export interface SseMessage {
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const message = parseChunk(chunk);
        if (message) yield message;
        split = buffer.indexOf("\n\n");
      }
    }
    const tail = parseChunk(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a successful response and then yield the exact body text. The capture
 * side is read immediately so `tee` does not stall the decoder.
 */
export async function* decodeWithRaw(
  status: number,
  body: ReadableStream<Uint8Array>,
  decode: (stream: ReadableStream<Uint8Array>) => AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  const [forDecode, forCapture] = body.tee();
  const captured = readStreamText(forCapture);
  try {
    yield* decode(forDecode);
  } finally {
    yield { type: "response", status, body: await captured };
  }
}

/** Read a fetch body to text. Used to keep the raw response next to the parsed stream. */
export async function readStreamText(body: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(chunk: string): SseMessage | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}
