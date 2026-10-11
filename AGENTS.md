# mya

A terminal harness. The model continues a transcript. The harness runs tools and appends the
results. See `README.md` for packages and usage, and `PRD.md` for scope and slices.

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

## Working in this repo

- Keep the core small. New behavior goes into an extension or a package before it goes into core.
- Promote something into an abstraction only after the same pattern has shown up more than once.
- Do not add a model step or tool call that bypasses the event stream or the session JSONL. If it
  isn't traced, it can't be inspected or replayed.
- Keep raw request and response payloads reachable. Don't normalize away information that someone
  debugging a run would need.
- Build only the slice the prompt names. `PRD.md` lists later slices and what stays out of core.
- Local code and local text stay on the core tools: `read` and `bash`, including grep. Do not reach
  for `pi-search` to look through the workspace.
- `pi-search` is for a corpus that is not already text in the workspace, such as a library of PDFs,
  and only after that corpus has been indexed. LiteParse is that ingest. The model then calls
  `search` (BM25) and `grep`. Reranking that list (`pi-jev`, BGE, another model, a hybrid) is an
  extension.
