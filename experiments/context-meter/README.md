# Context meter

An opt-in log of whether a run died because the context window filled up, or because it hit the turn cap. It does not compact, plan, or change the loop. Load it with `-e` when you want the measurement.

```bash
mya -e ./experiments/context-meter/meter.mjs -p "read README.md and summarize it"
node experiments/context-meter/report.mjs
```

From another working directory, pass an absolute path to `meter.mjs`. One JSON line is appended when the run ends, at `MYA_CONTEXT_METER_FILE` or `<cwd>/.mya/context-meter.jsonl` (the agent's cwd, so `-C` is honored). `.mya/` is gitignored. The script prints the overflow rate (context endings / logged runs), the turn-cap rate, and the median peak as a percent of the window per model.

```bash
node experiments/context-meter/report.mjs path/to/context-meter.jsonl
```

A missing log exits 1. An empty log prints `no runs` and exits 0.

## What one line records

Peak prompt tokens over finished turns (`input` + cache read + cache write, output excluded), the model's input window, and why the run ended: `context`, `turn_cap`, `other_error`, `aborted`, or `completed`. The turn cap wins if both could apply. A provider usage total is preferred. If the failing request never returned usage, the peak is `chars/4` of that request's system prompt, tool schemas, and messages, labeled `estimate`.

The meter keeps a reference to the latest context snapshot and drops it when the turn ends. It stringifies that snapshot only if the turn never closed, and it writes the log once, with `appendFileSync`, at `agent_end`. A log failure is printed to stderr and does not fail the run.

## Windows

| Provider | Model | Window the peak is compared to |
| --- | --- | --- |
| `anthropic` | `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929` | 200,000. The 1M beta is not enabled. |
| `openai` | `gpt-4.1` | 1,047,576 |
| `openai` | `gpt-5.5` | 1,050,000 |
| `openai-codex` | `gpt-5.5` | 272,000 input. Codex advertises 400k and reserves 128k for output. |

A snapshot id ending in `-YYYY-MM-DD` uses the base model's window. `gpt-5.5-pro` does not. Other models, including a local model behind `OPENAI_BASE_URL`, stay unknown until you set the real limit:

```bash
MYA_CONTEXT_WINDOW=32000 mya -e ./experiments/context-meter/meter.mjs --provider openai --model llama3 -p "..."
```

Underscores in the number are ignored (`200_000`). An invalid value is logged as an unknown window and does not crash the run. `PI_CONTEXT_WINDOW` is not read.
