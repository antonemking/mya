import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bashTool, checkTool, editTool, readTool, writeTool } from "../dist/index.js";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-tools-"));
const context = (cwd) => ({ cwd, signal: new AbortController().signal, toolCallId: "t1", turn: 1 });

test("read returns numbered lines", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  const result = await readTool.execute({ path: "a.txt" }, context(cwd));
  assert.equal(result.output, "1\tone\n2\ttwo\n3\tthree");
});

test("read honours offset and limit and reports the range", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "1\n2\n3\n4\n5\n");
  const result = await readTool.execute({ path: "a.txt", offset: 2, limit: 2 }, context(cwd));
  assert.match(result.output, /2\t2/);
  assert.match(result.output, /showing lines 2-3 of 5/);
});

test("read refuses a path outside the working directory", async () => {
  const cwd = await workspace();
  await assert.rejects(() => readTool.execute({ path: "../escape.txt" }, context(cwd)), /escapes the working directory/);
});

test("write creates parent directories", async () => {
  const cwd = await workspace();
  const result = await writeTool.execute({ path: "nested/dir/file.txt", content: "hi\n" }, context(cwd));
  assert.match(result.output, /wrote nested\/dir\/file.txt/);
  assert.equal(await readFile(join(cwd, "nested/dir/file.txt"), "utf8"), "hi\n");
});

test("edit replaces one occurrence and refuses an ambiguous match", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "cat\ncat\n");
  await assert.rejects(
    () => editTool.execute({ path: "a.txt", old_string: "cat", new_string: "dog" }, context(cwd)),
    /appears 2 times/,
  );
  await editTool.execute({ path: "a.txt", old_string: "cat", new_string: "dog", replace_all: true }, context(cwd));
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "dog\ndog\n");
});

test("bash runs in the working directory and reports a failure", async () => {
  const cwd = await workspace();
  const ok = await bashTool.execute({ command: "pwd" }, context(cwd));
  assert.ok(ok.output.includes(cwd.replace("/private", "")) || ok.output.includes(cwd));
  assert.notEqual(ok.isError, true);

  const bad = await bashTool.execute({ command: "exit 3" }, context(cwd));
  assert.equal(bad.isError, true);
  assert.match(bad.output, /exit code 3/);
});

test("check reports pass or fail from the exit code and a score when one is printed", async () => {
  const cwd = await workspace();
  const passed = await checkTool.execute({ command: "echo score: 0.75" }, context(cwd));
  assert.equal(passed.isError, undefined);
  assert.equal(passed.check.passed, true);
  assert.equal(passed.check.command, "echo score: 0.75");
  assert.equal(passed.check.score, 0.75);
  assert.match(passed.check.output, /score: 0.75/);

  const failed = await checkTool.execute({ command: "echo no-score; exit 2" }, context(cwd));
  assert.equal(failed.isError, true);
  assert.equal(failed.check.passed, false);
  assert.equal(failed.check.score, undefined);
  assert.match(failed.output, /fail/);
});

test("bash kills a command that runs past its timeout", async () => {
  const cwd = await workspace();
  const result = await bashTool.execute({ command: "sleep 5", timeout_ms: 150 }, context(cwd));
  assert.equal(result.isError, true);
  assert.match(result.output, /killed after 150ms/);
});
