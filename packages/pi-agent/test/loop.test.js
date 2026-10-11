import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, eventsFileFor, JsonlSession, readEvents } from "../dist/index.js";
import { recordEvents, StubModel, types } from "./stub.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-test-"));

test("a tool turn and an answer turn, in event order", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "README.md"), "# Demo\n\nA demo file.\n");

  const model = new StubModel([
    [{ id: "call_1", name: "read", arguments: { path: "README.md" } }],
    [{ text: "The README describes a demo." }],
  ]);
  const agent = new Agent({ model, cwd });
  const events = recordEvents(agent);

  const result = await agent.run("read README.md and summarize it");

  assert.equal(result.turns, 2);
  assert.equal(result.reason, "end_turn");
  assert.deepEqual(types(events), [
    "agent_start",
    "turn_start",
    "context_snapshot",
    "message_update",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "turn_start",
    "context_snapshot",
    "message_update",
    "turn_end",
    "agent_end",
  ]);

  // The second call sees the tool result.
  const secondCall = model.calls[1];
  const toolResult = secondCall.messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /A demo file/);
});

test("the transcript keeps each tool result as its own message", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [
      { id: "a", name: "bash", arguments: { command: "echo one" } },
      { id: "b", name: "bash", arguments: { command: "echo two" } },
    ],
    [{ text: "done" }],
  ]);
  const agent = new Agent({ model, cwd });
  await agent.run("run two commands");

  const toolMessages = agent.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0].content, /one/);
  assert.match(toolMessages[1].content, /two/);
});

test("an extension adds a tool the model can call", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [{ id: "call_1", name: "weather", arguments: { city: "Berlin" } }],
    [{ text: "It is raining." }],
  ]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [
      {
        name: "weather-ext",
        tools: [
          {
            name: "weather",
            description: "Report the weather.",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            execute: (args) => ({ output: `rain in ${args.city}` }),
          },
        ],
      },
    ],
  });
  await agent.run("what is the weather");

  assert.ok(model.calls[0].tools.some((t) => t.name === "weather"));
  const toolMessage = agent.messages.find((m) => m.role === "tool");
  assert.equal(toolMessage.content, "rain in Berlin");
});

test("an extension refuses bash and the refusal is the tool result", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [{ id: "call_1", name: "bash", arguments: { command: "rm -rf /" } }],
    [{ text: "Understood, I will not run that." }],
  ]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [
      {
        name: "no-bash",
        beforeToolCall: ({ call }) =>
          call.name === "bash" ? { output: "bash is disabled in this workspace", isError: true } : undefined,
      },
    ],
  });
  const events = recordEvents(agent);
  await agent.run("delete everything");

  const end = events.find((e) => e.type === "tool_execution_end");
  assert.equal(end.outcome.refusedBy, "no-bash");

  const nextCall = model.calls[1];
  const toolResult = nextCall.messages.find((m) => m.role === "tool");
  assert.equal(toolResult.content, "bash is disabled in this workspace");
});

test("terminate skips the next model call only when every result sets it", async () => {
  const cwd = await workspace();
  const stop = {
    name: "stop",
    description: "Stop the run.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ output: "stopped", terminate: true }),
  };
  const keepGoing = {
    name: "note",
    description: "Take a note.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ output: "noted" }),
  };

  const allTerminate = new Agent({
    model: new StubModel([[{ id: "a", name: "stop" }]]),
    cwd,
    extensions: [{ name: "ext", tools: [stop, keepGoing] }],
  });
  const terminated = await allTerminate.run("stop");
  assert.equal(terminated.reason, "terminated");
  assert.equal(terminated.turns, 1);

  const mixed = new Agent({
    model: new StubModel([
      [
        { id: "a", name: "stop" },
        { id: "b", name: "note" },
      ],
      [{ text: "carried on" }],
    ]),
    cwd,
    extensions: [{ name: "ext", tools: [stop, keepGoing] }],
  });
  const carried = await mixed.run("mixed batch");
  assert.equal(carried.reason, "end_turn");
  assert.equal(carried.turns, 2);
});

test("steering inserted during a tool skips the rest of that batch", async () => {
  const cwd = await workspace();
  let markRunning;
  const running = new Promise((resolve) => {
    markRunning = resolve;
  });
  let laterRan = false;
  const slow = {
    name: "slow",
    description: "Takes a moment.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      markRunning();
      return new Promise((resolve) => setTimeout(() => resolve({ output: "slow done" }), 40));
    },
  };
  const later = {
    name: "later",
    description: "Should not run.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      laterRan = true;
      return { output: "later ran" };
    },
  };
  const model = new StubModel([
    [
      { id: "a", name: "slow", arguments: {} },
      { id: "b", name: "later", arguments: {} },
    ],
    [{ text: "adjusted" }],
  ]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [{ name: "ext", tools: [slow, later] }],
  });
  const events = recordEvents(agent);

  const resultPromise = agent.run("do both");
  await running;
  agent.steer("stop and answer now");
  const result = await resultPromise;

  assert.equal(laterRan, false);
  assert.equal(result.turns, 2);
  assert.equal(result.reason, "end_turn");
  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "user", "assistant"]);
  assert.equal(agent.messages[2].toolName, "slow");
  assert.equal(agent.messages[2].content, "slow done");
  assert.equal(agent.messages[3].toolName, "later");
  assert.equal(agent.messages[3].isError, true);
  assert.match(agent.messages[3].content, /not run/);
  assert.equal(agent.messages[4].content, "stop and answer now");
  const second = model.calls[1].messages;
  assert.equal(second.at(-1).content, "stop and answer now");
  assert.equal(second.filter((m) => m.role === "tool" && m.toolName === "later" && !m.isError).length, 0);
  const steer = events.find((event) => event.type === "steer");
  assert.equal(steer.text, "stop and answer now");
  assert.deepEqual(steer.skipped, [{ id: "b", name: "later" }]);
  const steerAt = events.findIndex((event) => event.type === "steer");
  assert.ok(steerAt > events.findIndex((event) => event.type === "tool_execution_end" && event.call.name === "slow"));
  assert.ok(steerAt < events.findIndex((event) => event.type === "turn_start" && event.turn === 2));
});

test("a follow-up during tools waits until the model would stop", async () => {
  const cwd = await workspace();
  let markRunning;
  const running = new Promise((resolve) => {
    markRunning = resolve;
  });
  let laterRan = false;
  const slow = {
    name: "slow",
    description: "Takes a moment.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      markRunning();
      return new Promise((resolve) => setTimeout(() => resolve({ output: "slow done" }), 40));
    },
  };
  const later = {
    name: "later",
    description: "Still runs.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      laterRan = true;
      return { output: "later ran" };
    },
  };
  const model = new StubModel([
    [
      { id: "a", name: "slow", arguments: {} },
      { id: "b", name: "later", arguments: {} },
    ],
    [{ text: "first answer" }],
    [{ text: "second answer" }],
  ]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [{ name: "ext", tools: [slow, later] }],
  });

  const resultPromise = agent.run("do both");
  await running;
  agent.followUp("next task");
  const result = await resultPromise;

  assert.equal(laterRan, true);
  assert.equal(result.turns, 3);
  assert.equal(result.reason, "end_turn");
  assert.equal(agent.messages[4].role, "assistant");
  assert.equal(agent.messages[4].content[0].text, "first answer");
  assert.equal(agent.messages[5].content, "next task");
  assert.equal(agent.messages[6].content[0].text, "second answer");
  const betweenTools = model.calls[1].messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(betweenTools, ["do both"]);
});

test("steering lands after the tool batch, follow-ups start another turn", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [{ id: "a", name: "bash", arguments: { command: "echo hi" } }],
    [{ text: "first answer" }],
    [{ text: "second answer" }],
  ]);
  const agent = new Agent({ model, cwd });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") agent.steer("actually, check the exit code too");
    if (event.type === "turn_end" && event.turn === 2) agent.followUp("now say it again");
  });

  const result = await agent.run("run something");
  assert.equal(result.turns, 3);

  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "user", "assistant", "user", "assistant"]);
  assert.equal(agent.messages[3].content, "actually, check the exit code too");
  assert.equal(agent.messages[5].content, "now say it again");
});

test("transformContext rewrites the context without touching the transcript", async () => {
  const cwd = await workspace();
  const model = new StubModel([[{ text: "ok" }]]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [
      {
        name: "compactor",
        transformContext: ({ messages }) => [
          { role: "user", content: "summary of earlier turns" },
          ...messages.slice(-1),
        ],
      },
    ],
  });
  await agent.run("hello");

  assert.equal(model.calls[0].messages[0].content, "summary of earlier turns");
  assert.equal(agent.messages[0].content, "hello");
});

test("convertToLlm drops messages the provider cannot read", async () => {
  const cwd = await workspace();
  const model = new StubModel([[{ text: "ok" }]]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [
      {
        name: "notes",
        transformContext: ({ messages }) => [...messages, { role: "custom", kind: "note", payload: { a: 1 } }],
      },
    ],
  });
  await agent.run("hello");
  assert.equal(model.calls[0].messages.length, 1);
  assert.equal(model.calls[0].messages[0].role, "user");
});

test("shouldStopAfterTurn ends the run after a normal turn", async () => {
  const cwd = await workspace();
  const model = new StubModel([
    [{ id: "a", name: "bash", arguments: { command: "echo hi" } }],
    [{ text: "never reached" }],
  ]);
  const agent = new Agent({
    model,
    cwd,
    extensions: [{ name: "one-turn", shouldStopAfterTurn: ({ turn }) => turn >= 1 }],
  });
  const result = await agent.run("go");
  assert.equal(result.reason, "stopped");
  assert.equal(result.turns, 1);
});

test("an unknown tool becomes a tool result instead of a crash", async () => {
  const cwd = await workspace();
  const model = new StubModel([[{ id: "a", name: "nope", arguments: {} }], [{ text: "ok" }]]);
  const agent = new Agent({ model, cwd });
  await agent.run("go");
  const toolMessage = agent.messages.find((m) => m.role === "tool");
  assert.match(toolMessage.content, /unknown tool: nope/);
  assert.equal(toolMessage.isError, true);
});

test("the session file holds one JSON record per message", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "README.md"), "hello\n");
  const file = join(cwd, "session.jsonl");
  const model = new StubModel([
    [{ id: "a", name: "read", arguments: { path: "README.md" } }],
    [{ text: "it says hello" }],
  ]);
  const agent = new Agent({ model, cwd, session: new JsonlSession({ file }) });
  await agent.run("read it");

  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((r) => r.message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(
    records.map((r) => r.seq),
    [0, 1, 2, 3],
  );
});

test("maxTurns stops a loop that will not settle", async () => {
  const cwd = await workspace();
  const script = Array.from({ length: 10 }, (_, i) => [
    { id: `call_${i}`, name: "bash", arguments: { command: "echo loop" } },
  ]);
  const agent = new Agent({ model: new StubModel(script), cwd, maxTurns: 3 });
  const result = await agent.run("loop forever");
  assert.equal(result.reason, "max_turns");
  assert.equal(result.turns, 3);
});

test("each model call records a context snapshot after transformContext", async () => {
  const cwd = await workspace();
  const file = join(cwd, "session.jsonl");
  const model = new StubModel([[{ text: "ok" }]]);
  const scripted = model.stream.bind(model);
  model.stream = async function* (request) {
    yield { type: "request", body: JSON.stringify({ system: request.system, messages: request.messages }) };
    yield* scripted(request);
    yield { type: "response", status: 200, body: "data: done\n\n" };
  };
  const agent = new Agent({
    model,
    cwd,
    session: new JsonlSession({ file }),
    extensions: [
      {
        name: "compactor",
        transformContext: ({ messages }) => [{ role: "user", content: "summary of earlier turns" }, ...messages.slice(-1)],
      },
    ],
  });
  await agent.run("hello");

  const events = await readEvents(eventsFileFor(file));
  const snapshot = events.find((event) => event.type === "context_snapshot");
  const request = events.find((event) => event.type === "model_request");
  assert.ok(snapshot, "the event log has a context snapshot");
  assert.ok(snapshot.system.includes("Working directory"));
  assert.ok(snapshot.tools.some((tool) => tool.name === "read" && tool.parameters));
  assert.equal(snapshot.messages[0].content, "summary of earlier turns");
  assert.equal(snapshot.messages.at(-1).content, "hello");
  assert.ok(events.findIndex((event) => event.type === "context_snapshot") < events.findIndex((event) => event.type === "model_request"));
  assert.match(request.body, /hello/);
  assert.equal(request.body.includes("summary of earlier turns"), true);
});

test("a check result is an event in the stream and the event log", async () => {
  const cwd = await workspace();
  const file = join(cwd, "session.jsonl");
  const model = new StubModel([
    [{ id: "a", name: "check", arguments: { command: "echo score: 1; echo ok" } }],
    [{ text: "checked" }],
  ]);
  const agent = new Agent({ model, cwd, session: new JsonlSession({ file }) });
  const events = recordEvents(agent);
  await agent.run("check it");

  const live = events.find((event) => event.type === "check");
  assert.equal(live.command, "echo score: 1; echo ok");
  assert.equal(live.passed, true);
  assert.equal(live.score, 1);
  assert.match(live.output, /ok/);
  assert.equal(agent.goal, undefined);

  const logged = await readEvents(eventsFileFor(file));
  const saved = logged.find((event) => event.type === "check");
  assert.equal(saved.passed, true);
  assert.equal(saved.score, 1);
});

test("a session writes an event log that includes the raw provider bodies", async () => {
  const cwd = await workspace();
  const file = join(cwd, "session.jsonl");
  const model = new StubModel([[{ text: "ok" }]]);
  const scripted = model.stream.bind(model);
  model.stream = async function* (request) {
    yield { type: "request", body: JSON.stringify({ messages: request.messages }) };
    yield* scripted(request);
    yield { type: "response", status: 200, body: "data: done\n\n" };
  };
  const agent = new Agent({ model, cwd, session: new JsonlSession({ file }) });
  await agent.run("hello");

  const events = await readEvents(eventsFileFor(file));
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_start", "turn_start", "context_snapshot", "model_request", "message_update", "model_response", "turn_end", "agent_end"],
  );
  const request = events.find((event) => event.type === "model_request");
  assert.match(request.body, /hello/);
  const response = events.find((event) => event.type === "model_response");
  assert.equal(response.status, 200);
  assert.equal(response.body, "data: done\n\n");
});
