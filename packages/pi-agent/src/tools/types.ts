/**
 * A tool is named text in and named text out. The model never receives a file
 * handle, a socket, or a process.
 */
export interface ToolContext {
  /** Working directory the run is anchored to. */
  cwd: string;
  signal: AbortSignal;
  toolCallId: string;
  turn: number;
}

export interface CheckReport {
  command: string;
  /** True when the command exited 0. */
  passed: boolean;
  output: string;
  /** Present only when the command printed a `score:` line. */
  score?: number;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /**
   * Skip the next model call. The loop only honours it when every result in
   * the batch sets it.
   */
  terminate?: boolean;
  /**
   * Set by the check tool. The loop copies this onto a check event and does
   * not keep it or decide what the score means.
   */
  check?: CheckReport;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments the model supplies. */
  parameters: Record<string, unknown>;
  execute(args: unknown, context: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
}

/** What actually happened: the tool ran, an extension refused it, or it failed. */
export interface ToolOutcome extends ToolResult {
  /** Set when an extension returned the result text instead of the tool. */
  refusedBy?: string;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
