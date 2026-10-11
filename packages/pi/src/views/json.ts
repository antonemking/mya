import type { AgentEvent } from "pi-agent";

export interface JsonViewOptions {
  write: (text: string) => void;
}

/** JSON mode: the same events, one JSON object per line. */
export function jsonView({ write }: JsonViewOptions): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
