# mya

A terminal harness, built from the pi PRD. The command is `mya` so it can sit beside an installed
`pi` without either one shadowing the other. The model continues a transcript. The harness runs tools and appends the results.
People adapt the harness with extensions. They do not fork it.

One turn is one model call plus the tool calls that came back with it. If there are tool results,
the harness calls the model again. If the model answers in text, the run stops, unless a follow-up
was queued.

## Core idea

**Inspectable primitives let your harness evolve.**

Start with primitives, observe behavior, replay failures, promote repeated wins into abstractions,
and let the harness evolve.

## Design stance

Mya begins deliberately bare-bones rather than encoding a large philosophy up front.

- Model/API adapter
- Agent loop
- Tool interface
- Trace every model step and tool call
- Raw request/response payload inspection
- Replay as a first-class primitive

## Packages

| Package | Owns |
| --- | --- |
| `pi-ai` | Streaming provider calls and subscription logins, behind one interface. |
| `pi-agent` | The loop, the transcript, the four tools, extension hooks, JSONL sessions. |
| `pi` | The `mya` CLI. Print, JSON, and the TUI are views of the same events. |
| `pi-compaction` | Compaction, installed as an extension. |
| `pi-search` | LiteParse ingest, then BM25 and grep over the chunks as `search`, `grep`, and `read_chunk` tools, installed as an extension. |
| `pi-jev` | A Jev reranker: one TypeSafe Noul per query–candidate pair. A library for now, not an extension. |
| `pi-viz` | The browser visualization, installed as an extension. |

The model client does not import the tools. The tools do not know the provider URL.

## Install

```bash
npm install
npm run build
npm link -w packages/pi          # puts `mya` on your PATH, pointing at this checkout
```

Rebuild after pulling changes; the link follows the checkout, so there is nothing to reinstall.

## Use it with a ChatGPT subscription

```bash
mya login                        # opens the browser; sign in with your ChatGPT account
mya login --device               # no browser on this machine: enter a code on another device
mya status                       # what is signed in, and which provider and model are the defaults
mya                              # TUI
mya -p "read README.md and summarize it"
mya config set model gpt-5.4     # pick another Codex model; `mya config unset model` to go back
```

The first `mya login` makes `openai-codex` the default provider if you had none. Credentials go to
`~/.mya/auth.json`, owner-only, and refresh on their own; `mya logout` forgets them. Settings live in
`~/.mya/settings.json`. `MYA_HOME` moves both.

This rides the Codex CLI's sign-in and the ChatGPT Codex backend, not the public API: usage counts
against your ChatGPT plan, and OpenAI can change that backend without notice. Two knobs are worth
knowing: `MYA_REASONING_EFFORT` (`none`, `minimal`, `low`, `medium` default, `high`, `xhigh`) and
`MYA_TEXT_VERBOSITY` (`low`, `medium` default, `high`).

## Providers

```bash
mya --provider openai-codex -p "..."    # ChatGPT subscription, after `mya login`
mya --provider anthropic -p "..."       # ANTHROPIC_API_KEY
mya --provider openai -p "..."          # OPENAI_API_KEY
OPENAI_BASE_URL=http://localhost:11434/v1 mya --provider openai --model llama3 -p "..."
```

The provider comes from `--provider`, then `$MYA_PROVIDER`, then `mya config`, then `anthropic`. The
model comes from `--model`, then `$MYA_MODEL`, then `mya config` (only for the configured
provider), then the provider's default.

Every client implements the same `ModelClient` and speaks the same `StreamRequest`, so the loop, the
tools, and the views never learn a URL, a request body, or a token. The CLI passes a name to
`createModelClient` and gets a client back; keys and logins stay inside `pi-ai`. Usage is
normalised across all three: `inputTokens` always means fresh prefill, with cache reads reported
separately.

The Codex backend is stateless (`store: false`), so the whole transcript goes up on every call. Its
encrypted reasoning comes back as an `opaque` block tagged with the provider, is saved in the
session, and is sent back verbatim on the next call; every other adapter skips it.

For development, `node scripts/pi.mjs …` runs the CLI with the repo's gitignored `.env` loaded, and
`node scripts/trace.mjs` prints the acceptance trace, falling back to an SSE fixture without a key.

## Tools

`read`, `write`, `edit`, and `bash`. The model names a tool and supplies arguments; the harness runs
it and appends the text result. The model never receives a file handle, a socket, or a process.
`read`, `write`, and `edit` stay inside the working directory. `bash` runs as the user with that
directory as its cwd. There is no sandbox and no approval dialog.

## Events

`agent_start`, `turn_start`, `message_update` while tokens stream, `tool_execution_start`,
`tool_execution_end`, `turn_end`, and `agent_end` when the run stops. Print mode, JSON mode, and the
TUI are all subscribers. None of them is a second loop.

## TUI

`mya` with no `-p` and a terminal on stdin opens an interactive session. It renders a turn the same
way print mode does, sharing `views/format.ts`, and adds a banner, a spinner while a call or a tool
is in flight, and a prompt. One agent spans the session, so later prompts continue the transcript.
`--tui` forces it when stdin is a pipe. Slash commands are handled by the view and never reach the
model: `/help`, `/tools`, `/session`, `/clear`, `/exit`. Ctrl+C interrupts a run, Ctrl+D exits.

## Extensions

An extension registers tools, rewrites the context before a call, refuses a tool call, or ends the
run after a turn. A refused call still appears in the transcript as a tool result, so the next model
call can see why it did not run. Compaction is a `transformContext` hook; core ships the hook and no
policy. `transformContext` also receives the loop's model client, the session, and an `append`, so a
policy can make its own model call and write into the session without reaching for a provider.

```bash
mya -p "run ls" -e ./examples/extensions/no-bash.js
mya -p "what is the weather in Berlin" -e ./examples/extensions/weather.js
```

## Visualization

```bash
mya --viz                        # TUI in the terminal, a live picture of each request in the browser
mya --viz -p "..."               # same for one prompt; the page stays up until you press Enter
```

`pi-viz` is an extension, loaded last so it sees the context after every other extension has shaped
it. It serves a page on `127.0.0.1:7337` (the next free port if that one is taken; `MYA_VIZ_PORT`
to choose, `MYA_VIZ_OPEN=0` to not open a tab) and streams the same events the other views get, plus
a read-only snapshot of what each call sends. The page shows your machine and the provider on
either side of the wire: the transcript travelling out, the model thinking until the first token,
answer and tool-call tokens streaming back, and tools running locally. A narration line explains
each step, the tape shows what the model reads and how much of it was a cache hit, and **Replay
run** re-animates a finished run at a pace you can follow. Encrypted reasoning never reaches the
page, and requests with any other `Host` header are refused.

## Sessions

The transcript is appended to a JSONL file under `.mya/sessions` in the working directory, one
record per message. That file is the only state: resume, continue, and fork all read it back.

```bash
mya --sessions                                 # list what is on disk
mya -c -p "..."                                # continue the most recent session
mya -r <id> -p "..."                           # resume by path, id, or id prefix
mya --fork <id> --at 2 -p "..."                # fork before the 2nd user message
```

A resumed session keeps appending to its own file, so the next model call sees the earlier tool
results and does not repeat the work. A fork copies the path up to an earlier user message into a
new file and stops just before it, so the new prompt takes a different branch; the source file is
only read. `--at` counts user messages from one and defaults to the last. An ambiguous id prefix is
refused rather than guessed. With no `-p`, all three open the TUI on the loaded transcript.

Beside each session file is an event log, `{id}.events.jsonl`. It records the same events the views
see, plus the raw provider request and response bodies. Headers stay out, so a credential is not in
the file. `--no-session` writes neither file.

```bash
mya replay <id>          # print the recorded run; the model is not called
mya replay <id> --json   # the events, including the raw bodies
mya replay <id> --viz    # the same run in the browser; Replay run plays it back
```

## Compaction

`pi-compaction` is the policy, installed as an extension. Core has no threshold and no summarizer.

```bash
mya -c -e pi-compaction -p "..."
PI_CONTEXT_WINDOW=1500 PI_COMPACT_KEEP_TAIL=2 mya -c -e pi-compaction -p "..."
```

When the context passes `contextWindow × threshold` (defaults 200000 and 0.8) it summarizes the old
turns, keeps a recent tail, and appends the summary to the JSONL as a `custom` record of kind
`pi/compaction`. The tail is snapped forward to a user message so a tool result never outlives its
tool call. The summary request runs with `cache: false`, since its prefix will never repeat. The
turn after a compaction starts from a new prefix and reports a cache read of 0; the turn after that
reads the summary back from cache. A resumed or forked session finds the record and reuses the
summary instead of paying to build it again.

Two switches stay off unless set, so a plain `-e pi-compaction` still summarizes at 200000 tokens.

```bash
PI_COMPACT_STAGED=1 mya -e pi-compaction -p "..."
PI_COMPACT_MODEL_WINDOW=1 mya -e pi-compaction -p "..."
```

`PI_COMPACT_STAGED=1` elides stale bulky tool output first. The model sees a short stub (tool name, size, and a note to re-read or re-run). Recent turns stay. Nothing is recallable. The summarizer runs only if the transcript is still over the hard line (0.85 of the window; the soft line is 0.6). The same switch sizes the window to the model that was called. `PI_COMPACT_MODEL_WINDOW=1` sizes the window without elision. `PI_CONTEXT_WINDOW` overrides the table. An unknown model keeps the 200000 fallback. On these switches the estimate includes the system prompt and the tool schemas, and after the first turn it scales by the prompt tokens the provider reported.

## Search

Local code and local text do not use this. The model greps and reads them with the core tools.

`pi-search` is for a corpus that is not already text in the workspace, such as a library of PDFs, and
only after that corpus has been indexed. It stays out of core. LiteParse is not a tool the model calls.

LiteParse runs at ingest. A PDF becomes markdown, then chunks on disk, and that step is over before a
search starts. The model calls two tools from the package: `search` (BM25) and `grep`. The agent loop
expands the question, then calls them. The merged hit list is the result. `read_chunk` reads a hit
once its id is known. Nothing in this package reranks.

Jev stays in `pi-jev`. A reranker — Jev, BGE, another model, or a hybrid — is an extension that may
reorder the list afterwards.

```bash
MYA_SEARCH_CORPUS=experiments/search-eval/data/corpus mya -e pi-search -p "which baselines does the BRLM paper compare with?"
```

`experiments/search-eval` measures whether that loop beats one-shot retrieval. It parses 40 QASPER
papers from arXiv, labels the chunks that hold each question's human-marked evidence, and scores BM25,
embeddings, the agent, and each of those reranked by Jev.

```bash
node experiments/search-eval/prepare.mjs --papers 40      # download, parse, chunk, label
node experiments/search-eval/run.mjs --limit 20           # arms; OPENAI_API_KEY and TYPESAFE_API_KEY enable the rest
node experiments/search-eval/report.mjs                   # metrics into data/report.md
```

## Browser (experiment)

Not in core and not a package yet. `experiments/browser-smoke/browser.mjs` is an extension that drives
Chrome through Playwright and gives the model each page as an accessibility snapshot with element refs,
so it fits the text-only tool interface and `mya replay` shows every page the model saw.
`experiments/browser-smoke/README.md` is the design note; `run.mjs` scores a model on three small web
tasks against ground truth.

```bash
node experiments/browser-smoke/run.mjs --provider scripted       # no model: checks the plumbing
node experiments/browser-smoke/run.mjs --provider openai-codex   # after `mya login`
```

## Out of scope

Sub-agents, plan mode, a built-in todo tool, permission popups, MCP, and background bash stay out of
the core packages. An extension or a package may add them.
