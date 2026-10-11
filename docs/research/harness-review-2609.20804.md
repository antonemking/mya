# Harness review: arXiv 2609.20804

First pass over [An Empirical Study of Harness Design for Coding Agents](2609.20804.pdf) (Fan, Zhang, Ma, Hu, Wang, Song, Liu, Zamani, Wang; arXiv:2609.20804v1, 17 Sep 2026), mapped onto Mya as it is in this tree. No harness code changes. The PDF beside this note is the preprint.

The study is useful because it varies one harness component at a time. It is not a recipe Mya can copy. The models, the task mix, and several bundled mechanisms differ from this repo, and the authors say the crossover points have to be rechecked before they are transferred.

## What the paper measured

The execution loop stays fixed. Three components move:

| Component | What they turned on and off |
| --- | --- |
| Context management | Five tiers, T0–T4, at context budgets of 32k, 64k, 96k, and 128k tokens |
| Planning | On vs off, only at T4 and 128k |
| Action space | Predefined tools vs bash-only, only at T4 and 128k |

Models: Nemotron-3 30B, 120B, and 550B, plus Mistral-Medium-3.5-128B. Benchmarks: SWE-Bench Verified (500 tasks) and Terminal-Bench 2.1 (89 tasks). 176 matched settings, one run per task, temperature 0. Success rate and mean cost. Trajectory labels explain the mechanism: context management mostly lengthens runs, planning changes where they stop, and the action space changes how coarse each edit is.

The four findings, in the form that matters for a design choice:

1. **Context management pays when the window is tight**, and almost all of that pay is avoiding overflow. Averaged across models, the success gap between the managed tiers and no management shrinks as the window grows: 35.7, 15.9, 5.5, and 2.7 percentage points on SWE-Bench at 32k, 64k, 96k, and 128k, and 9.5, 7.5, 4.8, and 2.8 points on Terminal-Bench. Unmanaged overflow falls from 78.7% to 8.7% of SWE-Bench tasks, and from 61.0% to 12.1% on Terminal-Bench. Every managed tier overflows on zero tasks.
2. **Rule-based elision before LLM summarization (T4) is the cheap policy. A recall tool is not.** T4 keeps success similar to the other managed tiers and has the lowest average cost at every budget, because early elision often makes the summary call unnecessary. Adding `recall_event` (T2 vs T1) does not raise accuracy (equal-weight mean difference −0.36 points). In 36 of 64 recall-enabled settings the model never calls it. Mean calls per task fall from 0.54 at 32k to 0.007 at 128k, and the stronger models almost never call it.
3. **Planning is an accuracy scaffold for the weak model and a cost cut for the strong ones.** On Nemotron-3 30B, planning raises SWE-Bench success by 11.6 points and Terminal-Bench by 4.5, at higher cost, mostly by keeping runs alive until an edit. Without it, 68.6% of that model's SWE-Bench runs end with no edit (27.8% with planning on). On Nemotron-3 550B and Mistral-Medium-3.5, planning cuts SWE-Bench cost by about 30% and 32% and success by 2.0 and 0.4 points. The missing turns are mostly repeated verification.
4. **Predefined tools help a weak shell user. Bash-only is cheaper, and often enough, for a strong one.** Predefined tools raise Nemotron-3 30B by 15.0 points on SWE-Bench and 10.1 on Terminal-Bench. For 550B, bash-only raises success by 3.6 and 5.6 points and cuts cost by 53% on SWE-Bench and 30% on Terminal-Bench, with fewer, larger edits. Mistral splits by task: the full tool set wins by 23.2 points on repository repair; bash-only wins by 6.7 points on the command-line benchmark, where that model already issued 71.9% of its workspace actions as bash.

Two limits sit on every recommendation below. Planning and the action space were ablated only at T4/128k, so their interaction with a tight window is unmeasured. The action-space result is a bundle: tool list, prompt, read-before-write state, and automatic post-edit diagnostics move together. Model size is an imperfect stand-in for skill. The paper's own limitation section says to revalidate the crossover on other families.

## Where Mya is today

Mya is the same shape of harness: one model call, then the tool calls from that response, then another call if there were results (`packages/pi-agent/src/agent.ts`, `Agent.run`). Extensions may rewrite the transcript before the call (`transformContext` in `packages/pi-agent/src/extensions.ts`). Core ships the hook and no context policy. That split is the right place for anything this paper suggests. The PRD keeps plan mode, a built-in todo tool, permission prompts, sub-agents, MCP, and background bash out of core (`PRD.md`, "Out of core").

### Models Mya actually targets

There is no router that picks a harness from a capability score. A name is resolved and a client is constructed (`packages/pi/src/settings.ts`, `resolveProviderAndModel`; `packages/pi-ai/src/providers.ts`).

| Provider | Default model | How a person gets there |
| --- | --- | --- |
| `anthropic` | `claude-sonnet-4-5-20250929` | Default when nothing else is set (`packages/pi-ai/src/anthropic.ts`) |
| `openai-codex` | `gpt-5.5` | `mya login`, the documented subscription path (`packages/pi-ai/src/codex.ts`, `README.md`) |
| `openai` | `gpt-4.1` | `OPENAI_API_KEY`, or any OpenAI-compatible server via `OPENAI_BASE_URL` (`packages/pi-ai/src/openai.ts`) |

Relative to the paper, Sonnet 4.5 and GPT-5.5 sit at the strong end of the axis the authors probed with Nemotron-3 550B and Mistral-Medium-3.5. GPT-4.1 is unmeasured in the study. A small model behind `OPENAI_BASE_URL` is the weak end, the place where planning and predefined tools carried the accuracy gains. Mya does not record a context-window size per model. Compaction's default window is a constant, described below, and it is not read from the provider.

Output caps differ from the paper's 16,384 tokens per turn: the Anthropic and OpenAI clients default to 8,192 (`maxTokens` on those clients). Codex reasoning effort defaults to medium (`MYA_REASONING_EFFORT`). Temperature is sent only when a request sets it, so ordinary runs use the provider default, not the paper's temperature 0.

### Context management

**Default runs do no cross-turn compaction.** `transformContext` returns the transcript unchanged unless an extension rewrites it. A provider error, including a window overflow, ends the run with `reason: "error"` (`Agent.run`'s catch). The raw response body is already on the event log as `model_response`, so an overflow is inspectable after the fact.

**`pi-compaction` is optional and is closest to the paper's T3** (summarize, no elision, no recall). Load it with `-e pi-compaction`. When the estimate crosses `contextWindow × threshold`, it summarizes the older messages, keeps a tail, and appends a `custom` record of kind `pi/compaction` (`packages/pi-compaction/src/index.ts`).

| Knob | Mya default | Paper's T4 |
| --- | --- | --- |
| Window | `PI_CONTEXT_WINDOW` or 200,000 | The budget under test (32k–128k), i.e. the real window |
| Trigger | One threshold, `PI_COMPACT_THRESHOLD` or 0.8 | Soft 0.6 (elide), hard 0.85 (summarize) |
| What is compacted | Every message older than the tail, via one LLM call | Bulky tool observations in the middle first; summarize only if still over the hard line |
| Tail | `PI_COMPACT_KEEP_TAIL` or 6 messages, snapped forward to a user message | A token budget of 0.3 of the window, at least two turns, plus the preamble, all verbatim |
| Estimator | `JSON.stringify(messages).length / 4` | Provider token counts of the history |
| Recoverability | No model-facing tool. The original messages stay in the session JSONL; the model view skips them via `covers` | T2/T4 expose `recall_event`. T1 throws the body away |
| Summary call | Same client, `cache: false`, cap 2,048 tokens, free-form prompt | Same model, tool-free, fixed headings (goal, files, done, pending, errors, state, next step) |

If the tail is the whole transcript, `chooseTailStart` returns 0 and compaction leaves the transcript unchanged. The source comment on that branch says a bigger window is the only answer. There is no log line. A huge recent tool result can therefore overflow with the extension loaded. The estimate also ignores the system prompt and the tool schemas, so the provider can reject a request the extension still thinks fits.

The summary call does not go through `Agent.#streamTurn`. Its token usage is stored on the compaction record. Its raw request and response are not appended to `{id}.events.jsonl`. The main turn's wire bodies are.

What already matches the paper:

- The policy lives in an extension. Core does not hard-wire a summarizer (`PRD.md` extensions; `ExtensionHost.transformContext`).
- There is no `recall_event`. The paper's strongest negative result on context is that this tool does not earn its keep. Keeping the bytes in the JSONL for a person, and out of the model prompt, matches both that result and Mya's inspectability rule.
- The summary request sets `cache: false`, because that prefix will not repeat. The following turn is a new prefix (`README.md`, Compaction). The paper does not measure cache, but Mya already records `inputTokens`, `cachedInputTokens`, and `cacheWriteTokens` separately, which is the right cost split for an ablation.
- A resumed or forked session reuses the stored summary instead of paying for it again.

What does not match, and is the actual gap:

- No rule-based elision stage. The first time the estimate trips, Mya pays for a full summary of the head. T4's cost win is avoiding that call.
- The window is not the model's window. On a 200k-class model the default can be in the right neighborhood. On a small local model, a 200k default means the extension never fires and the provider overflows, which is the paper's T0 failure with the extension installed.
- The tail is a message count. The paper's recent window is a token budget, so a few bulky observations cannot consume it.

**Per-call truncation is a different mechanism.** It runs inside the tool, before the observation is stored, and it is not reversible:

- `read` returns at most 2,000 lines by default, clips a line at 2,000 characters, and refuses files over 400,000 bytes (`packages/pi-agent/src/tools/read.ts`).
- `bash` and `check` keep the first 60,000 characters (`packages/pi-agent/src/tools/bash.ts`, `packages/pi-agent/src/tools/check.ts`).
- Browser snapshots cap at `MYA_BROWSER_MAX_CHARS` (12,000) in `experiments/browser-smoke/browser.mjs`.

The paper truncates tool results at 24,000 characters and can still elide what remains on a later turn. Mya's caps are permanent in the transcript. They reduce how fast the window fills. They do not implement T1 or T4. The browser design note already names the missing piece for snapshots: a `transformContext` hook that drops old snapshots while the JSONL keeps them (`experiments/browser-smoke/README.md`, "The cost of text"). That hook is not written. It is the paper's elision result aimed at the bulkiest observation Mya has.

### Planning

Mya has no plan tool, no plan reminder, and no per-turn plan injection. The system prompt names the working directory and the tools, tells the model not to guess file contents, and tells it to answer in text when it is done (`packages/pi-agent/src/prompt.ts`, `defaultSystemPrompt`). The paper's planning-on condition is a system block, a first-turn reminder, an `update_plan` tool, and a fresh copy of the plan injected before every later call without appending another copy to history (Appendix A.2).

This matches the paper's planning-off arm, and it matches the PRD: plan mode and a built-in todo stay out of core. An extension can do either, including by writing `TODO.md` with the existing `write` tool. That file is not the paper's scaffold. The effect they measured comes from showing the plan again on every call and from the instruction to make a plan before acting.

For Sonnet 4.5 and GPT-5.5, the paper's strong-model result is the one to take as a prior: expect a shorter run and a lower bill, and a small accuracy risk, not an accuracy gain. For a weak local model, the prior flips: the plan's job is to stop the run dying during lookup, before any edit. Mya's default turn budget interacts with that. `maxTurns` defaults to 30 per `run` (`Agent` constructor). The paper allows 300 steps, and the weak model's median SWE-Bench trajectory grew from 5 turns without planning to 40 with it. A 30-turn cap can cut off the same runs the plan was stretching. Turn numbers survive across a TUI session; the budget applies to each `run`.

### Action space

Core tools are `read`, `write`, `edit`, `bash`, and `check` (`packages/pi-agent/src/tools/index.ts`, `coreTools`). The README's tool list names the first four. `check` is a fifth: it runs a shell command and reports pass or fail from the exit code, and copies a `score:` line onto a `check` event. The loop does not decide what the score means.

There is no `list`, `glob`, `grep`, or `web_fetch` in core. Workspace search is `bash` (`rg`, `grep`, `find`). The PRD's later slice for `grep`, `find`, and `ls` is not built. `pi-search` adds `search`, `grep`, and `read_chunk` for an indexed corpus that is not already text in the tree, and the agent instructions say not to use it on local code (`AGENTS.md`, `packages/pi-search/src/index.ts`).

So Mya is neither arm of the paper:

- Against **bash-only**, Mya still has structured read, write, and edit. Those are the tools the paper removed in that arm, and they are what a weak model failed to express as shell. Mya's `edit` is the paper's targeted replace (`old_string` must match, `replace_all` optional). `write` replaces the whole file and does not require `overwrite: true`.
- Against the **full predefined set**, Mya has no discovery tools and no web fetch. Discovery is the shell. On Terminal-Bench, 66% of Nemotron-3 30B's bash-only runs ended after it emitted a tool name the registry did not have. Mya turns an unknown name into a tool result that lists the tools that do exist (`Agent.#runTool`), so the next call can see the mistake. That is a recovery path the paper's harness also had, in the form of an error observation, and it was not enough for the weak model.

Several things the paper bundled into "full tools" are absent here, so a future Mya ablation would not reproduce their bundle:

- No read-before-write gate. `edit` reads the file itself at execution time (`packages/pi-agent/src/tools/edit.ts`). It does not require an earlier `read`, and it does not hash the file for external changes. `write` overwrites an existing file with no prior read.
- No automatic post-edit diagnostics. The paper appends ruff, pyflakes, or a syntax check to Python edits. Mya's `check` runs only when the model calls it.
- No permission layer. `bash` runs as the user. Refusing a command is an extension (`examples/extensions/no-bash.js`, `beforeToolCall`). The PRD leaves permission prompts out of core.
- Path checks reject a relative path that leaves the working directory (`packages/pi-agent/src/tools/paths.ts`, `resolveInsideCwd`). They do not resolve symlinks. The paper's guard does. `bash` does not go through the path check.
- Tool calls in one turn run one after another. Codex advertises `parallel_tool_calls: true`, which only lets the model emit several calls. The paper runs up to eight read-only tools concurrently. That was held fixed, not ablated.

The strong-model prior for Sonnet and GPT-5.5: more predefined discovery tools are likely to add selection overhead, especially on shell-shaped work. The weak-model prior: `read` / `write` / `edit` are the part worth keeping, and a missing `grep`-shaped tool is the part that might strand a model that was trained to call one. Neither prior is a measurement on these models.

### Evals that exist, and what they do not answer

| Surface | What it scores | Why it does not settle this paper |
| --- | --- | --- |
| `npm test` | Loop order, tool behavior, compaction mechanics, sessions, providers | A stub model and a tiny window (`packages/pi-compaction/test/compaction.test.js` uses a 2,000-token window). Locks the mechanism. Says nothing about task success. |
| `experiments/search-eval` | Hit rate and rank of QASPER evidence chunks. The `agent` arm rewrites a question, calls `search` / `grep` / `read_chunk`, and `submit`s. `maxTurns` 15 | Retrieval, not a coding repair. Does not vary compaction, planning, or the core tool list. Sessions are replayable, which is the right artifact shape for a later ablation. |
| `experiments/browser-smoke` | Three web tasks against ground truth. `maxTurns` 12. Optional dollars per million tokens | Browser tools only. Too short and too narrow for the paper's trajectory effects. It is the best existing stress for bulky observations. |
| `packages/pi-agent/test/subagent.test.js` | A parent that sees only a child's final sentence misses the child's edit | Sub-agents are out of core and out of this paper's ablations. |

Nothing in the tree runs SWE-Bench or Terminal-Bench. That is fine for a first measurement. The paper's own Terminal-Bench contrasts are often short of significance at 89 tasks. A small paired suite can show overflow, cost, and "ended before any edit." It cannot claim a SWE-Bench number.

Mya already records the fields an ablation needs: `agent_end.reason`, turn count, usage, `context_snapshot` (the exact messages sent), `tool_execution_*`, `check` events, and the raw provider bodies (`packages/pi-agent/src/events.ts`, `packages/pi-agent/src/session.ts`). `mya replay` prints a finished run without calling the model. `mya --fork` copies a transcript up to an earlier user message; it does not re-execute that prefix under a new policy. A policy comparison has to run the task again.

## What already matches

- Context policy is an extension on `transformContext`, which is the seam the paper's T0–T4 variants need. Core stays free of a threshold.
- No recall tool. Original turns remain in the session file for a person and for replay.
- Summary requests opt out of prompt-cache writes.
- Local code is read with `read` and searched with `bash`, which is the strong-model side of the action-space result. `grep` / `find` / `ls` are not in core.
- Plan mode is out of core, which is the paper's planning-off condition and the right default for the strong models Mya documents first.
- Tool failures, unknown tools, and extension refusals come back as tool results, so the next call sees them. The loop does not crash.
- Usage splits fresh prefill from cache read and cache write, so a compaction ablation can see a new prefix instead of inferring it.

## What does not apply

- **Adopting T4's exact thresholds (0.6 / 0.85 / 0.3) as defaults.** Those fractions were not themselves ablated. The result is "elide before you summarize," at whatever line actually binds for the model in use.
- **Adding `recall_event` because T4 had it.** T4's gain over T1 is the summary stage under pressure, not the recall tool. T2 vs T1 isolates recall and finds nothing.
- **Putting planning or a todo tool in core** because the weak model needed them. The PRD forbids that, and the strong-model result does not ask for it on the default path.
- **Deleting `read`, `write`, and `edit`** because bash-only was cheaper for Nemotron-3 550B. That arm also removed the file tools a weak model could not imitate, and Mya is a general terminal harness, not a Terminal-Bench runner. The applicable lesson is to stop adding discovery tools to core until a weak-model run shows they are needed.
- **Stuck detection, the permission layer, and automatic ruff.** Held fixed in every cell. The paper does not estimate them. Automatic diagnostics are inside the action-space bundle, so they are not a separate recommendation.
- **Parallel read-only execution.** Held fixed. Mya's sequential execution changes latency, not the action vocabulary the paper scored.
- **Search-eval or the three browser tasks as the outcome metric** for these three components. They do not produce the long repair trajectories where the effects showed up. Browser snapshots are a reason to elide, not a benchmark for planning.
- **Treating Nemotron-3 30B's numbers as Sonnet's or GPT-5.5's.** The authors warn against that transfer. The priors below are hypotheses for an ablation, not expected deltas.

## Prioritized plan

Impact is on task completion and cost for the models Mya runs. Effort is change size: an extension and a small runner sit in front of a core change. Anything that changes model-visible behavior belongs in an extension until the same pattern has earned a promotion (`AGENTS.md`).

### 1. Measure whether the window is what stops a run

**Impact:** high as a gate, low as a feature. The paper's context result is mostly "runs that would have overflowed get to keep going." If Mya runs die at `max_turns` or finish inside the window, a new compaction policy will not move success.

**Effort:** small. No harness change. A script over existing `{id}.events.jsonl` files, plus one synthetic session.

**Models:** all three defaults, and one small local model if you have one. The local model is the one most likely to overflow under the 200k default.

**How to measure:**

- From real sessions, count `agent_end.reason`. Split `error` by the `model_response` status and body (overflow vs other). Also count `max_turns`. Note whether `-e pi-compaction` was loaded; the extension's stderr line is not in the event log, but a `pi/compaction` record in the session JSONL means it fired.
- Build a fixture that only grows context: a file large enough that a few `read` calls (2,000 lines each) plus a long `bash` (60,000 characters) approach a chosen budget. Run it with `--max-turns` high enough that the turn cap is not the limit (the paper's weak-model medians were around 40 turns with planning; use something above that, on the order of 80, and report the cap). Set `PI_CONTEXT_WINDOW` to 32k and to 128k with `-e pi-compaction`, and run the same fixture with no extension.
- Record, per run: reason, turns, usage, peak size of `context_snapshot.messages`, whether a compaction record was written, and that record's `usage`.
- Success on this fixture can be a trivial check (`check` or a unit test). The outcome that matters here is overflow rate and tokens, not repair quality.

Do not start item 2 until this shows overflows, or shows compaction firing so early that it dominates cost.

### 2. Elide stale bulky tool output before summarizing

**Impact:** high when item 1 says the window binds. That is long TUI sessions, resumed sessions, browser snapshots, and any model whose real window is near or below the compaction threshold. Low when item 1 says runs finish inside the window. On the paper's 128k cells the accuracy gap is a few points; the cost gap is the reason to prefer elision.

**Effort:** medium, and it stays in an extension. Implement it as a second `transformContext` policy next to `pi-compaction`, or behind a flag on that package. Promote it into the default compaction policy only if the ablation beats summary-only on Mya's models. Do not put it in `pi-agent`.

**Shape to try,** taken from the mechanism rather than from the unablated constants:

- Leave the system prompt, the first user task, and a recent tail verbatim.
- Over a soft line, replace the bodies of old tool results in the middle with a short stub: tool name, character count, and "re-read or re-run." Do not add a tool that fetches the original. The session JSONL already has it.
- Over a hard line, summarize what remains of the middle, as `pi-compaction` does now.
- Size the tail in estimated tokens, with a floor of two turns, and still elide inside the tail when the tail alone exceeds the window. Today's early return when `chooseTailStart` is 0 is the case a single large observation hits.
- Prefer the provider's last `inputTokens + cachedInputTokens` over `length / 4` when a previous turn reported usage. Keep the character estimate for the first turn.
- Set the window from the model. A table in the extension, overridable by `PI_CONTEXT_WINDOW`, is enough. The core client does not need a new field until more than one policy needs it.
- Write the summary call's raw request and response somewhere the event log can reach, the same way a normal turn does. Today that call is invisible to `mya replay` except for the stored usage. An ablation that cannot see the summary body cannot be replayed.

**Models:** run the strong default (Sonnet or GPT-5.5) and one weak local model. Expect the accuracy movement on the tight budget and on the weak model. Expect the strong model at a comfortable window to show a cost change and little accuracy change.

**How to measure:** four arms on the same tasks, at two budgets (a tight one and the model's real window).

| Arm | Policy |
| --- | --- |
| A | No extension (today's default) |
| B | Current `pi-compaction` |
| C | Elision only |
| D | Elide, then summarize |

Outcomes: task pass/fail, `reason === "error"` as the overflow proxy, mean input tokens, cache read, output tokens, count of summary calls (from compaction records), peak snapshot size. The paper's claim to test is: C and D overflow as rarely as B, D calls the summarizer less often than B, and D costs less at similar pass rate. A recall arm is not worth a cell.

Pin temperature to 0 for the comparison. Mya does not do that unless the request says so. Pair tasks and list disagreements. With a handful of tasks, treat the result as a direction, the way the paper treated many Terminal-Bench cells. The existing compaction unit test should grow a case that a stubbed tool body is what the next call sees, and that no summary call was made when elision was enough.

Browser snapshots are the right bulky input for arm C even before a coding suite exists: replay a smoke session through the hook and check that the JSONL still holds every snapshot while the next `context_snapshot` does not.

### 3. Leave planning off the default path. Try it as an extension only where the model quits early

**Impact:** depends on the model. Prior from the paper: accuracy for a weak model, cost for a strong one, with a small chance of a worse score on the strong one. No impact worth a core change.

**Effort:** medium for an extension, and that is the only acceptable place (`PRD.md`). The extension registers `update_plan`, stores the plan in the transcript as a `custom` message, and `transformContext` inserts the current plan once per call without appending a new copy. A `TODO.md` written with `write` does not reproduce the condition they measured.

**Models:** required split.

- Weak local model: the hypothesis is more runs that call `write` or `edit` at least once, higher pass rate, more turns, higher cost.
- Sonnet 4.5 and GPT-5.5: the hypothesis is fewer turns and lower input tokens, pass rate within a small band either way. If the strong model is not cheaper, drop the extension. Do not turn it on by default to "match the paper."

**How to measure:** planning on vs off, same tools, same context policy (whichever won item 2, or current compaction if item 2 has not landed). Tasks that need more than one edit, so a plan has something to track. From the event log:

- Pass/fail.
- Turns, tool-call count, input tokens per call (the paper's Table 5).
- Share of runs with no `write` or `edit` (the paper's Table 6). Mya can compute this with a script over `tool_execution_start`. No judge required for this cut.
- Share of `check` or test-shaped `bash` calls after the first edit, as a stand-in for the "redundant verification" the labels attributed to strong models. A phase judge like the paper's is optional and not required to see the cost effect.

Keep `--max-turns` above 30 on the weak model or the cap will imitate the failure mode planning is supposed to prevent. Report the cap next to the result.

### 4. Keep the hybrid tool list. Ablate bash-only before adding discovery tools

**Impact:** depends on the model and the task. For Sonnet and GPT-5.5 the prior is that `list` / `glob` / `grep` in core will not raise accuracy and may raise cost, especially on command-line work. For a weak local model the prior is that structured `read` / `edit` matter, and that a missing search tool might show up as `unknown tool` results. Mya's current hybrid is already the strong-model-shaped choice for search, and the weak-model-shaped choice for editing.

**Effort:** the measurement is a small runner. The product change is nothing until that runner says otherwise. Adding those tools to core is the PRD's later slice 5; this paper is a reason to wait, not a reason to start.

**Models:** same split as planning. Also split tasks into "edit a repo" and "do the work in the shell," because Mistral's result flipped on that cut.

**How to measure:** two registries, same prompts.

- Hybrid: today's `coreTools()`.
- Bash-only: construct `Agent` with only `bash`, the way `experiments/search-eval/run.mjs` passes `tools: []` and then adds the tools it wants. The CLI always loads core tools; this arm is a script, not a flag, unless the result says people need one.

Outcomes: pass/fail, cost, turns, fraction of calls whose name is `bash`, count of `unknown tool` results, fraction of runs with no `write` or `edit` (on the hybrid arm) or no successful file-changing command (on bash-only; a rough signal is a `bash` whose command contains a redirect or a heredoc, checked by reading the session). The paper's finer cut, re-patches and median edit size, can wait.

Do not bundle a ruff-after-edit hook into this comparison. The paper could not separate it from the tool list. Mya can, later, as its own on/off extension, and only if someone has a reason other than this paper.

### 5. Do not build

- A `recall_event` tool, or any model-facing index of elided tool output. Measure nothing further unless a real session shows the model stuck because a stub dropped a result it could not re-read. The paper's heavy-use cell (the weakest model, tightest window, command-line tasks) still scored below elision without recall.
- Stuck-loop detection, a permission classifier, or automatic diagnostics, as follow-ups from this study. They were not the experimental factors.
- A SWE-Bench or Terminal-Bench port as the first step. Item 1's fixture plus a dozen tasks with a `check` command is enough to accept or reject items 2–4. Use the paper's benchmarks only if a pilot is large enough that a paired test could move, and if the sandbox story is decided. Mya has no container and no approval dialog; those benchmarks assume a task container.

## Suggested order

1. Count overflow and turn-cap stops on real sessions, and on one synthetic growing session, at a tight budget and at the model's budget.
2. If the window binds, add elision-before-summary as an extension and run arms A–D. Point the window at the model.
3. Separately, on a weak model and on Sonnet or GPT-5.5, run planning on vs off. Keep it out of the default binary unless the strong model gets cheaper without losing passes.
4. Run hybrid vs bash-only on the same split before any `grep` / `glob` / `list` work in core.

Items 3 and 4 do not depend on item 2 finishing. They do depend on naming the model in the result. A single pooled score across Sonnet and a local model will hide the crossover the paper is about.
