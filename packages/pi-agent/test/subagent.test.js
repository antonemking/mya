import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, eventsFileFor, JsonlSession, readEvents, textOf } from "../dist/index.js";
import { StubModel } from "./stub.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-sub-"));

/** What a parent would actually be handed: the child's last text, nothing else. */
function childAnswer(agent) {
  const last = [...agent.messages].reverse().find((message) => message.role === "assistant");
  return textOf(last);
}

test("a parent that only receives the child's answer cannot see the mistake", async () => {
  const cwd = await workspace();
  const childSession = join(cwd, "child.jsonl");
  const child = new Agent({
    model: new StubModel([
      [{ id: "w", name: "write", arguments: { path: "lib.js", content: "export const n = 2;\n" } }],
      [{ text: "Reviewed lib.js. No issues." }],
    ]),
    cwd,
    session: new JsonlSession({ file: childSession }),
  });
  await child.run("review lib.js and fix anything wrong");
  const summary = childAnswer(child);

  const parentModel = new StubModel([
    [{ id: "b", name: "bash", arguments: { command: `printf '%s' '${summary}'` } }],
    [{ text: "Ship it. The review found no issues." }],
  ]);
  const parent = new Agent({ model: parentModel, cwd });
  await parent.run("ask a sub-agent to review lib.js, then decide");

  const handedToParent = parent.messages.find((message) => message.role === "tool");
  assert.equal(handedToParent.content, "Reviewed lib.js. No issues.");

  const parentSaw = JSON.stringify(parentModel.calls[1].messages);
  assert.equal(parentSaw.includes("export const n = 2"), false);
  assert.equal(parentSaw.includes("write"), false);
  assert.equal(parentSaw.includes("child.jsonl"), false);

  assert.equal(await readFile(join(cwd, "lib.js"), "utf8"), "export const n = 2;\n");
  const childEvents = await readEvents(eventsFileFor(childSession));
  const write = childEvents.find((event) => event.type === "tool_execution_start");
  assert.equal(write.call.name, "write");
  assert.equal(write.call.arguments.content, "export const n = 2;\n");
});

test("a child that dumps its whole log through bash is cut off at 60k", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [
      {
        id: "b",
        name: "bash",
        arguments: {
          command: `node -e "process.stdout.write('HEAD'); process.stdout.write('x'.repeat(70000)); process.stdout.write('TAIL')"`,
        },
      },
    ],
    [{ text: "got the log" }],
  ]);
  const agent = new Agent({ model, cwd });
  await agent.run("show me everything the child did");

  const tool = agent.messages.find((message) => message.role === "tool");
  assert.match(tool.content, /^HEAD/);
  assert.match(tool.content, /truncated at 60000 characters/);
  assert.equal(tool.content.includes("TAIL"), false);

  const seen = model.calls[1].messages.find((message) => message.role === "tool");
  assert.equal(seen.content.includes("TAIL"), false);
});

test("two agents writing one file in parallel keep neither other's edit", async () => {
  const cwd = await workspace();
  const run = (name, content) =>
    new Agent({
      model: new StubModel([
        [{ id: name, name: "write", arguments: { path: "lib.js", content } }],
        [{ text: `${name} done` }],
      ]),
      cwd,
      session: new JsonlSession({ file: join(cwd, `${name}.jsonl`) }),
    }).run(`implement ${name}`);

  const [alpha, beta] = await Promise.all([run("alpha", "export const n = 'alpha';\n"), run("beta", "export const n = 'beta';\n")]);

  const disk = await readFile(join(cwd, "lib.js"), "utf8");
  assert.ok(disk === "export const n = 'alpha';\n" || disk === "export const n = 'beta';\n");
  assert.equal(disk.includes("alpha") && disk.includes("beta"), false);

  const alphaSaw = JSON.stringify(alpha.messages);
  const betaSaw = JSON.stringify(beta.messages);
  assert.equal(alphaSaw.includes("beta"), false);
  assert.equal(betaSaw.includes("alpha"), false);
});
