import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { answersQuestion, rerank } from "../dist/index.js";

/** Answers with a noul read off the passage text, and records every request body. */
function fakeClient() {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const noul = Number(/p=([\d.]+)/.exec(body.state.passage.text)[1]);
    return new Response(
      JSON.stringify({ model: body.model, answers: { answers: { type: "noul", noul } }, usage: { input_tokens: 10, output_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { client: new TypeSafeClient({ apiKey: "test", fetch, logLevel: "off" }), bodies };
}

const candidates = [
  { id: "a", text: "p=0.2", title: "Paper A" },
  { id: "b", text: "p=0.9", title: "Paper A", section: "Results" },
  { id: "c", text: "p=0.2" },
];

test("sorts by noul, keeps the original order on ties, and sends one noul per pair", async () => {
  const { client, bodies } = fakeClient();
  const { ranked, usage } = await rerank({ paper: "Paper A", text: "what?" }, candidates, { client, model: "jev-test" });

  assert.deepEqual(ranked.map((r) => [r.id, r.noul, r.before]), [["b", 0.9, 1], ["a", 0.2, 0], ["c", 0.2, 2]]);
  assert.deepEqual(usage, { calls: 3, cachedCalls: 0, inputTokens: 30, outputTokens: 3 });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1], {
    model: "jev-test",
    state: { question: { paper: "Paper A", text: "what?" }, passage: { paper: "Paper A", section: "Results", text: "p=0.9" } },
    questions: { answers: answersQuestion },
  });
});

test("a cache hit does not call the API", async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) };
  const first = fakeClient();
  await rerank({ text: "q" }, candidates, { client: first.client, model: "m", cache });

  const second = fakeClient();
  const { ranked, usage } = await rerank({ text: "q" }, candidates, { client: second.client, model: "m", cache });
  assert.equal(second.bodies.length, 0);
  assert.equal(usage.cachedCalls, 3);
  assert.equal(ranked[0].id, "b");
});
