import { createServer, type Server } from "node:http";
import { generatePkce, randomState } from "./pkce.js";
import type { OAuthCredential } from "./store.js";

/**
 * ChatGPT subscription login, the same flow the Codex CLI uses: OAuth 2.0
 * authorization code with PKCE against auth.openai.com, a local callback on
 * port 1455, and a device-code fallback for machines without a browser.
 *
 * This is not a documented public API. It can change without notice, and
 * usage counts against the ChatGPT plan rather than an API account.
 */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const CALLBACK_PORT = 1455;
const SCOPE = "openid profile email offline_access";
const AUTH_CLAIM = "https://api.openai.com/auth";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

/** How the CLI takes part in a login without knowing any of its URLs. */
export interface AuthInteraction {
  /** Show the browser login URL. The caller may also open a browser. */
  showUrl(url: string): void | Promise<void>;
  /** Show a device code and where to enter it. */
  showDeviceCode(userCode: string, verificationUri: string): void | Promise<void>;
  /**
   * Optional fallback when the browser cannot reach the local callback: ask
   * for the redirect URL or the code. Must stop asking when the signal fires.
   */
  askForCode?(signal: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

export interface CodexLoginOptions {
  method?: "browser" | "device";
  /** Tests point these at a fake server. */
  authBaseUrl?: string;
  callbackPort?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function codexOriginator(): string {
  return process.env.MYA_CODEX_ORIGINATOR ?? "mya";
}

function authBase(override?: string): string {
  return (override ?? process.env.MYA_OPENAI_AUTH_URL ?? DEFAULT_AUTH_BASE).replace(/\/$/, "");
}

export async function loginOpenAiCodex(
  interaction: AuthInteraction,
  options: CodexLoginOptions = {},
): Promise<OAuthCredential> {
  return options.method === "device" ? deviceLogin(interaction, options) : browserLogin(interaction, options);
}

export async function refreshOpenAiCodex(
  credential: OAuthCredential,
  options: { authBaseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<OAuthCredential> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(`${authBase(options.authBaseUrl)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const fresh = await readTokens(response, "refresh");
  return toCredential({ ...fresh, refresh: fresh.refresh ?? credential.refresh });
}

async function browserLogin(interaction: AuthInteraction, options: CodexLoginOptions): Promise<OAuthCredential> {
  const base = authBase(options.authBaseUrl);
  const port = options.callbackPort ?? CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const { verifier, challenge } = generatePkce();
  const state = randomState();

  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", codexOriginator());

  const callback = await listenForCallback(port, state);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  interaction.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await interaction.showUrl(url.toString());

    const racers: Array<Promise<string>> = [callback.code, timeout(options.timeoutMs ?? LOGIN_TIMEOUT_MS, stop.signal)];
    if (interaction.askForCode) {
      racers.push(
        interaction.askForCode(stop.signal).then((input) => {
          const parsed = parseManualInput(input);
          if (parsed.state && parsed.state !== state) throw new Error("state mismatch in the pasted URL");
          if (!parsed.code) throw new Error("no authorization code in what was pasted");
          return parsed.code;
        }),
      );
    }
    racers.push(
      new Promise<string>((_, reject) => {
        stop.signal.addEventListener("abort", () => reject(new Error("login cancelled")), { once: true });
      }),
    );

    const code = await Promise.race(racers);
    return await exchangeCode(base, code, verifier, redirectUri, options.fetch);
  } finally {
    interaction.signal?.removeEventListener("abort", onAbort);
    stop.abort();
    callback.close();
  }
}

async function deviceLogin(interaction: AuthInteraction, options: CodexLoginOptions): Promise<OAuthCredential> {
  const base = authBase(options.authBaseUrl);
  const doFetch = options.fetch ?? globalThis.fetch;

  const start = await doFetch(`${base}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!start.ok) {
    throw new Error(`device login could not start (${start.status}): ${await start.text().catch(() => "")}`);
  }
  const device = (await start.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
  if (!device.device_auth_id || !device.user_code) {
    throw new Error(`unexpected device login response: ${JSON.stringify(device)}`);
  }

  await interaction.showDeviceCode(device.user_code, `${base}/codex/device`);

  let intervalMs = Math.max(1, Number(device.interval ?? 5)) * 1000;
  const deadline = Date.now() + (options.timeoutMs ?? DEVICE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (interaction.signal?.aborted) throw new Error("login cancelled");
    await sleep(intervalMs);

    const poll = await doFetch(`${base}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });

    if (poll.ok) {
      const done = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
      if (!done.authorization_code || !done.code_verifier) {
        throw new Error(`unexpected device token response: ${JSON.stringify(done)}`);
      }
      return exchangeCode(base, done.authorization_code, done.code_verifier, `${base}/deviceauth/callback`, doFetch);
    }
    if (poll.status === 403 || poll.status === 404) continue;

    const body = await poll.text().catch(() => "");
    if (body.includes("authorization_pending")) continue;
    if (body.includes("slow_down")) {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`device login failed (${poll.status}): ${body}`);
  }
  throw new Error("device login timed out");
}

async function exchangeCode(
  base: string,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<OAuthCredential> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const tokens = await readTokens(response, "exchange");
  if (!tokens.refresh) throw new Error("token exchange returned no refresh token");
  return toCredential({ ...tokens, refresh: tokens.refresh });
}

interface Tokens {
  access: string;
  refresh?: string;
  expires: number;
  idToken?: string;
}

async function readTokens(response: Response, operation: string): Promise<Tokens> {
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`token ${operation} failed (${response.status}): ${text}`);
  let json: { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`token ${operation} returned something other than JSON`);
  }
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error(`token ${operation} response is missing fields`);
  }
  return {
    access: json.access_token,
    ...(json.refresh_token ? { refresh: json.refresh_token } : {}),
    expires: Date.now() + json.expires_in * 1000,
    ...(json.id_token ? { idToken: json.id_token } : {}),
  };
}

function toCredential(tokens: Tokens & { refresh: string }): OAuthCredential {
  const access = decodeJwt(tokens.access);
  const id = tokens.idToken ? decodeJwt(tokens.idToken) : undefined;
  const accountId = claimAccountId(access) ?? claimAccountId(id);
  if (!accountId) throw new Error("the access token carries no ChatGPT account id");
  const email = typeof id?.["email"] === "string" ? (id["email"] as string) : undefined;
  return {
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    accountId,
    ...(email ? { email } : {}),
  };
}

function claimAccountId(payload: Record<string, unknown> | undefined): string | undefined {
  const auth = payload?.[AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
  return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id !== ""
    ? auth.chatgpt_account_id
    : undefined;
}

export function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseManualInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (value === "") return {};
  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  } catch {
    // Not a URL.
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^\?/, ""));
    const code = params.get("code");
    const state = params.get("state");
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  return { code: value };
}

interface Callback {
  code: Promise<string>;
  close(): void;
}

/**
 * The redirect goes to `localhost`, which a browser may resolve to either
 * loopback address, so listen on both and take whichever binds.
 */
async function listenForCallback(port: number, state: string): Promise<Callback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  code.catch(() => {});

  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(page("Not found."));
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const detail = url.searchParams.get("error_description") ?? error;
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page(`Login failed: ${detail}`));
      rejectCode(new Error(`login failed: ${detail}`));
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("State mismatch."));
      return;
    }
    const received = url.searchParams.get("code");
    if (!received) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Missing authorization code."));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Signed in to mya. You can close this tab."));
    resolveCode(received);
  };

  const servers: Server[] = [];
  const bind = (host: string) =>
    new Promise<void>((resolve) => {
      const server = createServer(handler);
      server.once("error", () => resolve());
      server.listen(port, host, () => {
        servers.push(server);
        resolve();
      });
    });
  await Promise.all([bind("127.0.0.1"), bind("::1")]);

  if (servers.length === 0) {
    throw new Error(
      `port ${port} is busy, so the browser callback cannot be received. ` +
        "Close any other login in progress (the Codex CLI uses the same port), or use device login.",
    );
  }

  return {
    code,
    close: () => {
      for (const server of servers) server.close();
    },
  };
}

function page(message: string): string {
  const safe = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>mya</title><body style="font-family:system-ui;padding:3rem"><p>${safe}</p></body>`;
}

function timeout(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("login timed out")), ms);
    timer.unref?.();
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
