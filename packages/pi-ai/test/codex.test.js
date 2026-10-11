import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CredentialStore,
  OpenAiCodexClient,
  buildCodexBody,
  decodeCodexStream,
  login,
  parseManualInput,
  toCodexInput,
} from "../dist/index.js";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const accessToken = (account = "acct_123") => fakeJwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: account } });

function sse(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 3)));
      controller.enqueue(bytes.slice(Math.floor(bytes.length / 3)));
      controller.close();
    },
  });
}

const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};

const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED" };
const callItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"README.md"}', status: "completed" };

function toolTurnEvents() {
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '"README.md"}' },
    { type: "response.output_item.done", output_index: 1, item: callItem },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 40 },
      },
    },
  ];
}

test("responses events map onto the neutral stream, and raw items ride in an opaque block", async () => {
  const events = await collect(decodeCodexStream(sse(toolTurnEvents())));

  const deltas = events.filter((e) => e.type === "tool_call_delta");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].id, "call_1");
  assert.equal(deltas[0].name, "read");

  const done = events.at(-1);
  assert.equal(done.type, "message_done");
  assert.equal(done.stopReason, "tool_use");
  assert.deepEqual(done.usage, { inputTokens: 400, cachedInputTokens: 600, cacheWriteTokens: 0, outputTokens: 40 });

  const [call, opaque] = done.message.content;
  assert.deepEqual(call, {
    type: "tool_call",
    id: "call_1",
    name: "read",
    arguments: { path: "README.md" },
    rawArguments: '{"path":"README.md"}',
  });
  assert.equal(opaque.type, "opaque");
  assert.equal(opaque.provider, "openai-codex");
  assert.deepEqual(opaque.data.items, [reasoningItem, callItem]);
});

test("text streams as deltas and a final answer ends the turn", async () => {
  const events = await collect(
    decodeCodexStream(
      sse([
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", output_index: 0, delta: "Hello " },
        { type: "response.output_text.delta", output_index: 0, delta: "there." },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello there." }] },
        },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 3 } } },
      ]),
    ),
  );
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => e.text),
    ["Hello ", "there."],
  );
  const done = events.at(-1);
  assert.equal(done.stopReason, "end_turn");
  assert.deepEqual(done.message.content[0], { type: "text", text: "Hello there." });
});

test("a failed response is an error, not an empty answer", async () => {
  await assert.rejects(
    () => collect(decodeCodexStream(sse([{ type: "response.failed", response: { error: { message: "model overloaded" } } }]))),
    /model overloaded/,
  );
});

test("codex's own assistant messages go back verbatim; others are rebuilt", () => {
  const input = toCodexInput([
    { role: "user", content: "read README.md" },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_1", name: "read", arguments: { path: "README.md" }, rawArguments: '{"path":"README.md"}' },
        { type: "opaque", provider: "openai-codex", data: { items: [reasoningItem, callItem] } },
      ],
    },
    { role: "tool", toolCallId: "call_1", toolName: "read", content: "# pi" },
    // From another provider, with another provider's opaque state.
    {
      role: "assistant",
      content: [
        { type: "text", text: "It is a harness." },
        { type: "opaque", provider: "someone-else", data: { secret: 1 } },
      ],
    },
  ]);

  assert.deepEqual(input[0], { role: "user", content: [{ type: "input_text", text: "read README.md" }] });
  assert.deepEqual(input[1], reasoningItem);
  assert.deepEqual(input[2], callItem);
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "# pi" });
  assert.equal(input[4].type, "message");
  assert.equal(input[4].content[0].text, "It is a harness.");
  assert.ok(!JSON.stringify(input).includes("secret"));
});

test("the request body is stateless and carries the system prompt as instructions", () => {
  const body = buildCodexBody(
    {
      model: "gpt-5.5",
      system: "you are mya",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      cacheKey: "session-1",
    },
    "gpt-5.5",
    { effort: "medium", verbosity: "medium" },
  );
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "you are mya");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.prompt_cache_key, "session-1");
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
  assert.deepEqual(body.tools[0], { type: "function", name: "read", description: "Read a file", parameters: { type: "object" }, strict: false });
  assert.equal(body.max_output_tokens, undefined);
});

async function tempStore(credential) {
  const dir = await mkdtemp(join(tmpdir(), "mya-auth-"));
  const store = new CredentialStore(join(dir, "auth.json"));
  if (credential) store.set("openai-codex", credential);
  return store;
}

function completedTextBody() {
  return sse([
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);
}

test("the client refuses to start without a login", async () => {
  const store = await tempStore();
  assert.throws(() => new OpenAiCodexClient({ store }), /not logged in to openai-codex/);
});

test("an expiring token is refreshed before the call and saved", async () => {
  const store = await tempStore({ type: "oauth", access: "old", refresh: "refresh-1", expires: Date.now() + 1000, accountId: "acct_123" });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth/token")) {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "refresh-1");
      return new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "refresh-2", expires_in: 3600 }));
    }
    return new Response(completedTextBody(), { headers: { "content-type": "text/event-stream" } });
  };

  const client = new OpenAiCodexClient({ store, fetch, authBaseUrl: "https://auth.test", baseUrl: "https://codex.test" });
  await collect(client.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }], cacheKey: "s1" }));

  assert.equal(calls[0].url, "https://auth.test/oauth/token");
  assert.equal(calls[1].url, "https://codex.test/codex/responses");
  const headers = calls[1].init.headers;
  assert.equal(headers.authorization, `Bearer ${accessToken()}`);
  assert.equal(headers["chatgpt-account-id"], "acct_123");
  assert.equal(headers["openai-beta"], "responses=experimental");
  assert.equal(headers["session-id"], "s1");

  const saved = store.get("openai-codex");
  assert.equal(saved.refresh, "refresh-2");
  assert.ok(saved.expires > Date.now() + 3000 * 1000);
  const mode = (await stat(store.file)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a 401 triggers one refresh and one retry", async () => {
  const store = await tempStore({ type: "oauth", access: "revoked", refresh: "r", expires: Date.now() + 3600_000, accountId: "acct_123" });
  let codexCalls = 0;
  const fetch = async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "r2", expires_in: 3600 }));
    }
    codexCalls += 1;
    return codexCalls === 1
      ? new Response(JSON.stringify({ detail: "token revoked" }), { status: 401 })
      : new Response(completedTextBody());
  };
  const client = new OpenAiCodexClient({ store, fetch, authBaseUrl: "https://auth.test", baseUrl: "https://codex.test" });
  const events = await collect(client.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(codexCalls, 2);
  assert.equal(events.at(-1).type, "response");
  assert.ok(events.some((event) => event.type === "message_done"));
});

test("a usage limit is reported as such", async () => {
  const store = await tempStore({ type: "oauth", access: accessToken(), refresh: "r", expires: Date.now() + 3600_000, accountId: "acct_123" });
  const fetch = async () => new Response(JSON.stringify({ error: { message: "You've hit your usage limit." } }), { status: 429 });
  const client = new OpenAiCodexClient({ store, fetch, baseUrl: "https://codex.test" });
  await assert.rejects(
    () => collect(client.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] })),
    /usage limit reached \(429\): You've hit your usage limit/,
  );
});

test("browser login: PKCE, local callback, token exchange, and a saved credential", async () => {
  const exchanges = [];
  const authServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      exchanges.push(new URLSearchParams(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: accessToken("acct_live"),
          refresh_token: "refresh-live",
          expires_in: 864000,
          id_token: fakeJwt({ email: "tone@example.com" }),
        }),
      );
    });
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  const authBaseUrl = `http://127.0.0.1:${authServer.address().port}`;
  const callbackPort = 20000 + Math.floor(Math.random() * 20000);

  const store = await tempStore();
  let authorizeUrl;
  try {
    const credential = await login(
      "openai-codex",
      {
        // Play the browser: follow the redirect straight to the local callback.
        async showUrl(url) {
          authorizeUrl = new URL(url);
          const state = authorizeUrl.searchParams.get("state");
          const response = await fetch(`http://localhost:${callbackPort}/auth/callback?code=code-123&state=${state}`);
          assert.equal(response.status, 200);
        },
        showDeviceCode() {
          throw new Error("not a device login");
        },
      },
      { store, authBaseUrl, callbackPort },
    );

    assert.equal(authorizeUrl.pathname, "/oauth/authorize");
    assert.equal(authorizeUrl.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizeUrl.searchParams.get("scope"), "openid profile email offline_access");

    // The verifier sent to the token endpoint hashes to the challenge sent to authorize.
    const exchange = exchanges[0];
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("code"), "code-123");
    const expected = createHash("sha256").update(exchange.get("code_verifier")).digest("base64url");
    assert.equal(authorizeUrl.searchParams.get("code_challenge"), expected);

    assert.equal(credential.accountId, "acct_live");
    assert.equal(credential.email, "tone@example.com");
    const saved = JSON.parse(await readFile(store.file, "utf8"));
    assert.equal(saved["openai-codex"].refresh, "refresh-live");
  } finally {
    authServer.close();
  }
});

test("a pasted redirect URL, query string, or bare code are all accepted", () => {
  assert.deepEqual(parseManualInput("http://localhost:1455/auth/callback?code=abc&state=xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseManualInput("code=abc&state=xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseManualInput("  abc  "), { code: "abc" });
  assert.deepEqual(parseManualInput(""), {});
});
