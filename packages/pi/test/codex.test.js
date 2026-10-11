import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedEnv } from "./env.js";
import { startFakeCodex } from "./fakeCodex.js";

const run = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })}.sig`;

async function workspace({ loggedIn = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "mya-codex-"));
  await writeFile(join(cwd, "README.md"), "# mya\n\nA terminal harness.\n");
  if (loggedIn) {
    const credential = {
      type: "oauth",
      access: accessToken,
      refresh: "refresh-fixture",
      expires: Date.now() + 3600_000,
      accountId: "acct_fixture",
      email: "tone@example.com",
    };
    await writeFile(join(cwd, "auth.json"), JSON.stringify({ "openai-codex": credential }), { mode: 0o600 });
  }
  return cwd;
}

const mya = (args, cwd, extra = {}) =>
  run(process.execPath, [cli, ...args], { cwd, env: isolatedEnv(cwd, { ANTHROPIC_API_KEY: "", ...extra }) });

test("mya --provider openai-codex shows a tool call, then the answer", async () => {
  const cwd = await workspace();
  const server = await startFakeCodex();
  try {
    const { stdout } = await mya(
      ["--provider", "openai-codex", "-p", "read README.md and summarize it", "--no-session"],
      cwd,
      { MYA_CODEX_BASE_URL: server.url },
    );

    assert.match(stdout, /mya · openai-codex\/gpt-5\.5/);
    const toolCall = stdout.indexOf('⏺ read {"path":"README.md"}');
    const turnTwo = stdout.indexOf("turn 2");
    assert.ok(stdout.indexOf("turn 1") < toolCall && toolCall < turnTwo);
    assert.match(stdout, /The README is titled "mya"/);
    assert.match(stdout, /end_turn · 2 turns/);

    // Stateless: the second call carries the reasoning and call items verbatim, then the output.
    assert.equal(server.requests.length, 2);
    const [first, second] = server.requests;
    assert.equal(first.url, "/codex/responses");
    assert.equal(first.body.store, false);
    assert.equal(first.headers["chatgpt-account-id"], "acct_fixture");
    assert.equal(first.headers.originator, "mya");
    const kinds = second.body.input.map((item) => item.type ?? item.role);
    assert.deepEqual(kinds, ["user", "reasoning", "function_call", "function_call_output"]);
    assert.equal(second.body.input[1].encrypted_content, "ENCRYPTED-REASONING");
    assert.equal(second.body.input[2].id, "fc_fixture");
    assert.equal(second.body.input[3].call_id, "call_fixture");
  } finally {
    await server.close();
  }
});

test("a resumed codex session sends the saved reasoning back up", async () => {
  const cwd = await workspace();
  const server = await startFakeCodex();
  try {
    const env = { MYA_CODEX_BASE_URL: server.url };
    await mya(["--provider", "openai-codex", "-p", "read README.md and summarize it"], cwd, env);
    await mya(["--provider", "openai-codex", "-c", "-p", "thanks"], cwd, env);

    const resumed = server.requests.at(-1).body.input;
    assert.ok(resumed.some((item) => item.type === "reasoning" && item.encrypted_content === "ENCRYPTED-REASONING"));
    assert.equal(resumed.at(-1).content[0].text, "thanks");
  } finally {
    await server.close();
  }
});

test("without a login, the error says how to sign in", async () => {
  const cwd = await workspace({ loggedIn: false });
  await assert.rejects(
    () => mya(["--provider", "openai-codex", "-p", "hi", "--no-session"], cwd),
    /not logged in to openai-codex\. Run `mya login openai-codex` first/,
  );
});

test("mya config sets the default provider, and status reports it", async () => {
  const cwd = await workspace();
  const server = await startFakeCodex();
  try {
    await mya(["config", "set", "provider", "openai-codex"], cwd);
    const settings = JSON.parse(await readFile(join(cwd, "settings.json"), "utf8"));
    assert.equal(settings.provider, "openai-codex");

    const { stdout: status } = await mya(["status"], cwd);
    assert.match(status, /provider {2}openai-codex {2}\(from config\)/);
    assert.match(status, /openai-codex +tone@example\.com/);

    // No --provider: the configured default is used.
    const { stdout } = await mya(["-p", "read README.md and summarize it", "--no-session"], cwd, {
      MYA_CODEX_BASE_URL: server.url,
    });
    assert.match(stdout, /mya · openai-codex\//);

    // A model configured for codex is not handed to another provider.
    await mya(["config", "set", "model", "gpt-5.4"], cwd);
    const { stdout: other } = await mya(["status"], cwd, { MYA_PROVIDER: "anthropic" });
    assert.match(other, /model {5}provider default/);

    await assert.rejects(() => mya(["config", "set", "provider", "nope"], cwd), /unknown provider nope/);
  } finally {
    await server.close();
  }
});

test("logout forgets the login and clears it as the default", async () => {
  const cwd = await workspace();
  await mya(["config", "set", "provider", "openai-codex"], cwd);
  const { stdout } = await mya(["logout"], cwd);
  assert.match(stdout, /Signed out of openai-codex/);
  assert.match(stdout, /Cleared openai-codex as the default provider/);
  const auth = JSON.parse(await readFile(join(cwd, "auth.json"), "utf8"));
  assert.equal(auth["openai-codex"], undefined);
});
