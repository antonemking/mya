import type { AgentEvent } from "pi-agent";
import { palette, toolLine, toolResultLine, usageLine } from "./format.js";

export interface PrintViewOptions {
  write: (text: string) => void;
  color?: boolean;
}

/**
 * Print mode: the answer plus a readable tool line. A subscriber to the event
 * stream, not a second loop.
 */
export function printView({ write, color = false }: PrintViewOptions): (event: AgentEvent) => void {
  const { dim, bold } = palette(color);
  let textThisTurn = false;

  return (event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        write(dim(`mya · ${event.provider}/${event.model} · ${event.cwd}`) + "\n");
        if (event.sessionFile) write(dim(`session · ${event.sessionFile}`) + "\n");
        break;

      case "turn_start":
        textThisTurn = false;
        write("\n" + bold(`turn ${event.turn}`) + "\n");
        break;

      case "message_update":
        if (event.delta.kind === "text") {
          if (!textThisTurn) {
            textThisTurn = true;
            write("  ");
          }
          write(event.delta.text.replace(/\n/g, "\n  "));
        }
        break;

      case "context_snapshot":
        write(dim(`  context · ${event.messages.length} messages · ${event.tools.length} tools`) + "\n");
        break;

      case "model_request":
        write(dim(`  request · ${event.body.length} chars`) + "\n");
        break;

      case "model_response":
        write(dim(`  response ${event.status} · ${event.body.length} chars`) + "\n");
        break;

      case "tool_execution_start":
        if (textThisTurn) write("\n");
        textThisTurn = false;
        write(`  ${toolLine(event.call.name, event.call.arguments, event.call.rawArguments)}\n`);
        break;

      case "tool_execution_end":
        write(dim(`    ${toolResultLine(event.outcome, event.durationMs)}`) + "\n");
        break;

      case "steer":
        write(dim(`  steer · ${event.text}`) + "\n");
        break;

      case "check":
        write(
          dim(
            `  check ${event.passed ? "pass" : "fail"} · ${event.command}${event.score === undefined ? "" : ` · score ${event.score}`}`,
          ) + "\n",
        );
        break;

      case "turn_end":
        if (textThisTurn) write("\n");
        write(dim(`  ${event.stopReason} · ${usageLine(event.usage)}`) + "\n");
        break;

      case "agent_end":
        write(
          "\n" +
            dim(
              `${event.reason} · ${event.turns} turn${event.turns === 1 ? "" : "s"} · ${usageLine(event.usage)}`,
            ) +
            "\n",
        );
        if (event.error) write(`error: ${event.error}\n`);
        break;

      default:
        break;
    }
  };
}
