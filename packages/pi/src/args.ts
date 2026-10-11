export type ViewMode = "print" | "json";

export interface CliOptions {
  prompt?: string;
  mode: ViewMode;
  /** Provider name. The CLI knows the name and nothing else about it. */
  provider?: string;
  model?: string;
  cwd: string;
  extensions: string[];
  sessionFile?: string;
  sessionDir?: string;
  noSession: boolean;
  /** Resume the most recent session. */
  continueSession: boolean;
  /** Resume this session: a path, an id, or an id prefix. */
  resume?: string;
  /** Fork this session into a new file. */
  fork?: string;
  /** Which user message to fork at, 1-based. Defaults to the last one. */
  at?: number;
  listSessions: boolean;
  maxTurns?: number;
  /** Force the TUI. Without a prompt on a terminal it starts anyway. */
  tui: boolean;
  /** Load the browser visualization. */
  viz: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "print",
    cwd: process.cwd(),
    extensions: [],
    noSession: false,
    continueSession: false,
    listSessions: false,
    tui: false,
    viz: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case "-p":
      case "--print":
        options.prompt = next();
        break;
      case "--mode": {
        const value = next();
        if (value !== "print" && value !== "json") throw new UsageError(`unknown mode: ${value}`);
        options.mode = value;
        break;
      }
      case "--json":
        options.mode = "json";
        break;
      case "--provider":
        options.provider = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "-C":
      case "--cwd":
        options.cwd = next();
        break;
      case "-e":
      case "--extension":
        options.extensions.push(next());
        break;
      case "--session":
        options.sessionFile = next();
        break;
      case "--session-dir":
        options.sessionDir = next();
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "-c":
      case "--continue":
        options.continueSession = true;
        break;
      case "-r":
      case "--resume":
        options.resume = next();
        break;
      case "--fork":
        options.fork = next();
        break;
      case "--at": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1) throw new UsageError("--at needs a positive whole number");
        options.at = value;
        break;
      }
      case "--sessions":
      case "--list-sessions":
        options.listSessions = true;
        break;
      case "--tui":
        options.tui = true;
        break;
      case "--viz":
        options.viz = true;
        break;
      case "--max-turns": {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 1) throw new UsageError("--max-turns needs a positive number");
        options.maxTurns = Math.trunc(value);
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--version":
        options.version = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown flag: ${arg}`);
        positional.push(arg);
        break;
    }
  }

  if (options.prompt === undefined && positional.length > 0) {
    options.prompt = positional.join(" ");
  }
  return options;
}

export const helpText = `mya — a terminal harness

Usage
  mya                                       Start the TUI
  mya -p "read README.md and summarize it"
  mya -p "..." --mode json
  mya --provider openai-codex -p "..."
  mya --viz                                 TUI plus a live picture of each request in the browser
  mya -c -p "..."                           Continue the most recent session
  mya -r <id> -p "..."                      Resume that session
  mya --fork <id> --at 2 -p "..."           Fork before its 2nd user message
  mya replay <id>                           Replay a recorded run, no model call
  mya replay <id> --json                    Same events, one JSON object per line
  mya replay <id> --viz                     Open that run in the browser; Replay run plays it

Accounts and settings
  mya login [provider] [--device]           Sign in with a subscription (openai-codex)
  mya logout [provider]                     Forget a subscription login
  mya status                                Show logins and defaults
  mya config set <provider|model> <value>   Set a default
  mya config unset <provider|model>         Clear a default

Options
  -p, --print <prompt>   Run one prompt and print the result
      --mode <view>      print (default) or json
      --tui              Start the TUI even when stdin is not a terminal
      --viz              Serve a live visualization on localhost and open it
                         ($MYA_VIZ_PORT, default 7337; MYA_VIZ_OPEN=0 to not open a tab)
      --json             Same as --mode json
      --provider <name>  anthropic, openai, or openai-codex
                         Defaults to $MYA_PROVIDER, then mya config, then anthropic
      --model <id>       Model id. Defaults to $MYA_MODEL, then mya config, then the provider's
  -C, --cwd <dir>        Working directory for the run and its tools
  -e, --extension <path> Load an extension module, repeatable
      --session <file>   Write the JSONL session to this file
      --session-dir <dir> Directory for session files, defaults to .mya/sessions
      --no-session       Do not write a session file
  -c, --continue         Resume the most recent session
  -r, --resume <ref>     Resume a session by path, id, or id prefix
      --fork <ref>       Fork a session into a new file, source untouched
      --at <n>           Fork before the nth user message, defaults to the last
      --sessions         List sessions and exit
      --max-turns <n>    Stop after n turns, defaults to 30
  -h, --help             Show this help
      --version          Show the version
`;
