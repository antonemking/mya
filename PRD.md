# Pi

A terminal harness. The model continues a transcript. The harness runs tools and appends the results. People adapt the harness with extensions, skills, prompt templates, and packages. They do not fork it.

If the prompt says to build the first slice, build that section and stop. Later slices are here so you can see the boundary. They are not permission to keep going.

## First slice

Deliver a CLI named `pi` that can run:

```bash
pi -p "read README.md and summarize it"
```

That run prints two turns. The first turn is a tool call. The second turn is the answer, after the harness has appended the tool result. Show that trace. Do not start a TUI.

### Layout

Three packages. The model client does not import the tools. The tools do not know the provider URL.

| Package | Owns |
| --- | --- |
| `pi-ai` | Streaming calls to one provider. First provider is Anthropic. |
| `pi-agent` | The loop, the transcript, the four tools, extension hooks, JSONL sessions. |
| `pi` | The CLI. Print mode and JSON mode are views of the same events. |

### Loop

One turn is one model call plus the tool calls that came back with it.

- If the assistant message contains tool calls, run them, append each result as its own message, and call the model again.
- If the assistant message is text and no follow-up is queued, stop.
- Steering messages that arrive during a run are inserted after the current tool batch, before the next model call.
- Follow-up messages wait until the model would otherwise stop, then start another turn.
- A tool result may set `terminate`. Skip the next model call only when every result in that batch sets it.
- Before each call, an optional `transformContext` may rewrite the transcript. An optional `convertToLlm` drops messages the provider cannot read.
- `shouldStopAfterTurn` may end the run after a normal turn. It does not cancel the stream in flight and it does not cancel tools already running.

The harness emits these events, in this order for a tool turn:

`agent_start`, `turn_start`, `message_update` while tokens stream, `tool_execution_start`, `tool_execution_end`, `turn_end`, and `agent_end` when the run stops.

Print mode writes the answer and a readable tool line. JSON mode writes the same events as JSON lines. Both are subscribers. Neither one is a second loop.

### Tools

Ship `read`, `write`, `edit`, and `bash`.

The model names a tool and supplies arguments. The harness runs the tool and appends the text result. The model never receives a file handle, a socket, or a process.

`read`, `write`, and `edit` stay inside the working directory. `bash` runs as the user, with that directory as its cwd. There is no sandbox and no approval dialog in this slice.

### Extensions

An extension can register a tool and can refuse a tool call by returning the result text itself. The loop calls that hook after it has parsed the arguments and before it runs the tool. A refused call still appears in the transcript as a tool result, so the next model call can see why it did not run.

Compaction is a hook on `transformContext`. The first slice provides the hook and does not hard-wire a summarizer. A later slice can install a policy that summarizes old turns when the context window fills.

### Session

Append the transcript to a JSONL file, one record per message. The first slice can start a new file per run. Resume and fork are a later slice.

### Provider

`pi-ai` streams Anthropic messages. It maps stream deltas onto `message_update` events, including tool-call deltas. It reports input tokens, cached input tokens, and output tokens when the provider sends them.

Input tokens are the prefill of the transcript. Output tokens are decode. A stable prefix is what a later call can cache. This slice does not implement compaction, so it must not rewrite earlier messages between turns.

### Acceptance

- `pi -p "read README.md and summarize it"` prints a tool call, then a summary that depends on the file.
- `--mode json` prints the event list above for that same run.
- An extension can add a tool the model is able to call.
- An extension can refuse `bash`, and the refusal text is the tool result on the next model call.
- No TUI, no second provider, no package installer.

## Later slices

Build these only when a later prompt names them.

1. **TUI.** A third subscriber to the same events. It does not grow a new loop.
2. **Sessions.** Resume, continue, and fork. Fork copies the JSONL path up to an earlier user message.
3. **Compaction extension.** When the transcript nears the window, summarize the old turns, keep a recent tail, and write the summary into the session. The summary request does not write a prompt cache. The next user turn is a new prefix.
4. **More providers.** Same `pi-ai` interface. Subscription logins and API keys stay inside the provider package.
5. **More tools.** `grep`, `find`, `ls`.
6. **Packages.** Install an extension, skill, prompt template, or theme from npm or git. Packages run with the user's full permissions. The installer says so.
7. **RPC and SDK.** RPC is the event stream over stdin and stdout. The SDK embeds the session in another Node process.

## Out of core

These stay out of the core packages even after the later slices. An extension or a package may add them. A pull request that puts them in core is rejected.

- Sub-agents. Another `pi` process, or an extension, can do this.
- Plan mode. A markdown file, or an extension, can do this.
- A built-in todo tool. A `TODO.md` file, or an extension, can do this.
- Permission popups. A container, or an extension, can do this.
- MCP. A skill can document a CLI. An extension can speak MCP.
- Background bash. tmux keeps the process visible.

## Done

The first slice is done when the print-mode trace shows two turns and the JSON mode shows the same events. The TUI starts after that trace is boring.
