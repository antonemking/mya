# Browser use in mya: design note and smoke test

**Recommendation.** Give mya a browser, not a desktop. Build it as an extension that drives Chrome
through Playwright and hands the model each page as text: an accessibility snapshot where every
element carries a ref (`button "Create account" [ref=e13]`). The model acts by ref (`browser_click
{"ref": "e13"}`). This fits today's tool interface with no core change. Every page the model saw
lands in the session JSONL, and `mya replay` shows it unchanged. The spike in this folder shows the
plumbing works. What it doesn't show yet is model quality on real pages, and that takes one command
with a key (see [Try it](#try-it)).

## 1. Three lanes, and Jev is not computer use

| Lane | What drives | What it sees | What it emits | In mya |
| --- | --- | --- | --- | --- |
| Provider computer/browser use | Anthropic's `computer_toolset_20260801` and its separate browser use tool; Gemini Computer Use (browser, desktop, mobile environments); OpenAI's Computer-Using Agent (Operator, now inside ChatGPT Agent) | Screenshots, plus page reading for Anthropic's browser tool | Provider-defined actions: click at x,y, type, key, scroll | No. Needs image tool results and provider-defined tool types in `pi-ai`, which is a core change. |
| LLM plus browser tools (this note) | Any tool-calling LLM mya already speaks to | Snapshot text with refs | Ordinary function calls: `browser_click {ref}` | Yes, via `browser.mjs` here. |
| Jev as the action picker | Code owns the loop. It turns the page into an indexed element table, one Jev request picks the operation and the target, and a small LLM writes only free text | Whatever state code builds | A typed choice with probabilities | No. |

`pi-jev` is a reranker: one Noul per query–candidate pair, sorted by the probability of yes. It never
acts. TypeSafe Jev itself cannot see a screen and does not generate text or tool arguments. It
answers typed questions over state you hand it. The "Jev is good at computer use" posts are row
three: `browser-use/jev-ultrafast` (Google Flights in about 7 s for about $0.004) and
`typesafe-computer-use` (a Mac driven through OCR). Both sets of numbers come from the authors and no
one has reproduced them. It is a lane worth testing, but it needs the page turned into a candidate
list first, and row two builds exactly that. So row two comes first.

## 2. The primitive

### Tools

| Tool | Arguments | Does |
| --- | --- | --- |
| `browser_open` | `url` | Navigate. Only http(s) URLs, and only allowlisted hosts. |
| `browser_snapshot` | `ref?` | Read the page again, or only one element's subtree. |
| `browser_click` | `ref` | Click. |
| `browser_type` | `ref`, `text`, `submit?` | Replace a field's text, then optionally press Enter. |
| `browser_select` | `ref`, `option` | Pick a select option by label or value. |

Every result is one text block. It has an action line, any navigation the allowlist blocked, then
the URL, the title, and Playwright's `ariaSnapshot({ mode: "ai" })`, capped at
`MYA_BROWSER_MAX_CHARS` (12000). A failed action still returns the page, so the model gets fresh
refs to recover with. A stale ref fails in milliseconds and says why.

**Why text rather than screenshots.** mya is text end to end: `ToolResult.output`,
`ToolResultMessage.content`, and `UserMessage.content` are all strings. Screenshots would need an
image block in `pi-ai`'s types, all three adapters, the session format, and `pi-viz`. That is a
core change worth making only when a text-only browser falls short on something we care about.
Text also has benefits of its own:

- Refs remove coordinate grounding, the classic failure of pixel agents.
- A replay shows exactly what the model read, and you can grep it.
- The same snapshot can feed Claude, GPT, a local model, or a Jev chooser, so drivers can be
  compared on identical input.

**The cost of text.** Full snapshots of real pages are large. Measured here: example.com is about 80
tokens, Hacker News and a GitHub repo page about 12k each, and a Wikipedia article about 36k. One
screenshot is about 1–1.8k tokens (per Anthropic's docs). The cap holds each result to about 3k
tokens, and `browser_snapshot {ref}` reads past the cap one part at a time. If real tasks still
blow up the context, the first fix is a `transformContext` hook that drops old snapshots before
each call. The session JSONL keeps all of them, which is exactly what that hook is for.

**Why Playwright over raw CDP.** For Chromium, Playwright is CDP underneath, and it adds snapshots
with refs, auto-waiting, and tracing. Drop to raw CDP only if Playwright hides something we need.
Playwright MCP exists, but MCP stays out of core, and wrapping it would give up control of the
output format.

### Events and replay

Core needs nothing new:

- `tool_execution_start` holds the action and its arguments. `tool_execution_end` holds the full
  page text the model got back, the duration, and `isError`. Both go into `<id>.jsonl` and
  `<id>.events.jsonl`, next to the raw model request and response bodies.
- `mya replay <file>` prints a run with no browser and no model.
- `MYA_BROWSER_TRACE=1` covers the browser side of raw inspection. It writes a Playwright trace (a
  screenshot per action, DOM snapshots, network) to `<id>.trace.zip` beside the session file. Open
  it with `npx playwright-core show-trace <file>`. The screenshots are for people; the model never
  sees them.
- Replay re-displays a run; it does not re-execute it. Live sites change, so the reproducible way to
  re-run the same actions is against the local fixture pages.

### Safety

What the spike does:

- Starts a fresh profile every run: no cookies, no logins, downloads off, service workers blocked.
- Refuses any URL that is not http(s), such as `file:`, `data:`, or `chrome:`.
- Checks `MYA_BROWSER_ALLOW` on every navigation the page makes, link clicks included, and tells the
  model what was blocked.
- Says in the tool descriptions and the smoke's system prompt that page text is untrusted.
- Leaves core tools out of the smoke, so the model can't `curl` its way around the browser. For the
  CLI, use `no-bash`.

Left for later: an approval step before submits and purchases (a `beforeToolCall` extension, the
same hook `no-bash` uses), running the browser in a container, and a prompt-injection check on page
text before acting. A Jev Noul fits that check well: it's cheap and fast, and a code-owned threshold
decides.

### Headed or headless

Headless is the default, for CI, cloud VMs, and the smoke. `MYA_BROWSER_HEADED=1` (or `--headed` in
the smoke) opens a window so you can watch. It is the same code path either way.

### Auth and cookies

v0 has none. The profile is thrown away after every run, and the model never sees a cookie. When a
task needs a login, the path is:

1. A person logs in once in a headed window.
2. The extension saves Playwright `storageState` under `.mya/` (owner-only, gitignored) and loads it
   by name.
3. The session records which state a run used, never its contents.

Never attach the user's real Chrome profile, and never put credentials in the transcript.

## 3. The smoke test

`run.mjs` gives a model three tasks through the real mya loop. Only the `browser_*` tools are
available, and each task is scored against ground truth:

| Task | Asks | Passes when |
| --- | --- | --- |
| `public-fact` | Heading of https://example.com and where "Learn more" points | The answer has both and the run really opened the page. Memory alone fails. |
| `click-fact` | Tracking code of Grace Hopper's order on a local orders page | The answer has the code. It is random per run and one click deep. |
| `form` | Sign up as "Ada Lovelace", Team plan, terms ticked, then report the code | The server received exactly those values and the answer has the code. |

Each attempt is a session under `data/runs/`, so any failure can be replayed. The table reports
pass/fail, turns, tool calls and errors, wall time, browser time, and tokens. It adds a cost column
when you pass prices with `--usd-in`, `--usd-out`, and `--usd-cached`, in dollars per million
tokens. Prices change, so none are hardcoded.

**Measured on this VM** (no model keys here, so plumbing only):

- Scripted driver: 6/6 passes. Browser time is 0.7–1.4 s per task, including the Chrome launch.
- A fake model that answers from memory: 0/3, each failing for the right reason.
- `mya -p` with the extension loaded exits cleanly in about 1.2 s, leaving no Chrome behind.

**Estimate for a real model** (not measured): 2–6 model calls per task. On fixture-sized pages the
whole smoke should take roughly 10–20k input tokens, mostly prefix-cache hits, plus about 1k output
tokens. That is cents on a frontier model. Wall time will be mostly model latency, since the browser
takes about 1 s per task.

**Models to run from here**, all through providers `pi-ai` already has:

- `openai-codex` after `mya login`: GPT-5.x on a ChatGPT plan, with no per-token bill.
- `anthropic` with `ANTHROPIC_API_KEY`: Claude Opus or Sonnet 5 class. Anthropic models lead the
  public OSWorld-Verified numbers (a pixel, full-desktop benchmark, so not this setup, but a fair
  signal for UI reasoning).
- `openai` with `OPENAI_API_KEY`, or any OpenAI-compatible `OPENAI_BASE_URL`: a local model shows
  how small a model can go on text snapshots. Gemini's OpenAI-compatible endpoint should also work
  this way, but it is untested.
- Jev is not a driver for this loop. Test it next as row three: same tasks, same fixture, with a
  driver that asks Jev for a Choice over the snapshot's refs.

## 4. Where it lives

It is an extension. For now that means `experiments/browser-smoke/browser.mjs`, loaded with `-e`.
Promote it to `packages/pi-browser`, an extension package like `pi-search`, once two things are
true: one real-model smoke says the tool shape is right, and a second consumer exists (the Jev arm,
or someone using it day to day). It needs no core tool and no new event type. The one core change
browser use could force later is images in tool results, for screenshots or pixel models. That
belongs in its own PR in `pi-ai` and `pi-agent`, made on its own merits.

## 5. Not in v0

- Full-desktop computer use: OS input, VMs, OCR.
- Screenshots or images sent to the model, and provider-native computer or browser toolsets.
- Logins, stored cookies, the user's real browser profile, payments, and irreversible actions.
- Multi-tab workflows, file upload and download, canvas-only apps, and content past what the
  snapshot shows.
- Re-executing recorded runs against live sites.
- A Jev driver, or reranking snapshot elements. That is the next experiment.
- Stealth, CAPTCHA solving, and bot-detection evasion.
- Parallel browsers or sub-agents.
- A new package, a core tool, or new event types.

## Try it

```bash
npm install && npm run build
node experiments/browser-smoke/run.mjs --provider scripted                  # plumbing, no model, ~4 s
node experiments/browser-smoke/run.mjs --provider openai-codex --repeat 3   # after `mya login`
node experiments/browser-smoke/run.mjs --provider anthropic --model <id> --repeat 3 --usd-in <$> --usd-out <$>
mya replay experiments/browser-smoke/data/runs/<run>/form-1.jsonl           # what the model saw, step by step

# by hand, watching the window
MYA_BROWSER_HEADED=1 MYA_BROWSER_ALLOW=example.com,iana.org \
  mya -e ./examples/extensions/no-bash.js -e ./experiments/browser-smoke/browser.mjs \
  -p "Open https://example.com, follow Learn more, and tell me the page title"
```

It uses the installed Chrome. If Chrome isn't installed, run `npx playwright-core install chromium`
and set `MYA_BROWSER_CHANNEL=chromium`. `--trace` saves a Playwright trace per attempt.

Good looks like 3/3 on each of three repeats, the form done in six tool calls or fewer, and zero
tool errors. After that, move to harder tasks: search and filter on a real site, a multi-page form
with validation errors, and a page bigger than the snapshot cap.
