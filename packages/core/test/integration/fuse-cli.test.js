import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFuseArgs, readOpinionContext } from "../../../cli/src/commands/work.js";

const panel = ["--model", "a/model", "--model", "b/model"];
test("fuse CLI requires one explicit writer and honors controls and literal tasks", () => {
  assert.throws(() => parseFuseArgs([...panel, "task"]), /requires --writer/);
  assert.throws(() => parseFuseArgs([...panel, "--writer", "c/model", "--writer", "d/model", "task"]), /exactly once/);
  for (const flag of ["--max-tokens", "--concurrency"]) {
    for (const value of ["0", "NaN", "Infinity", "1.5"]) assert.throws(() => parseFuseArgs([...panel, flag, value, "task"]), /positive integer/);
  }
  assert.throws(() => parseFuseArgs([...panel, "--writer", "c/model", ...Array(9).fill(["--context", "x"]).flat(), "task"]), /at most 8/);
  assert.deepEqual(parseFuseArgs([...panel, "--writer", "c/model", "--context", "brief.md", "--max-tokens", "500", "--concurrency", "1", "--json", "--", "--literal"]), {
    help: false, task: "--literal", models: ["a/model", "b/model"], writer: "c/model", contextFiles: ["brief.md"], maxTokens: 500, concurrency: 1, json: true,
  });
  assert.deepEqual(parseFuseArgs(["--help"]), { help: true });
});

test("shared context reader rejects symlink escapes and oversized context", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fuse-context-"));
  const outside = mkdtempSync(path.join(tmpdir(), "fuse-outside-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(path.join(outside, "file"), "external");
  symlinkSync(path.join(outside, "file"), path.join(root, "link"));
  assert.throws(() => readOpinionContext(root, ["link"]), /outside the mind project/);
  writeFileSync(path.join(root, "large"), "x".repeat(32769));
  assert.throws(() => readOpinionContext(root, ["large"]), /too large/);
  writeFileSync(path.join(root, "bounded"), "x".repeat(32768));
  assert.throws(() => readOpinionContext(root, Array(5).fill("bounded")), /combined context/);
});

test("fuse CLI accepts explicit direct execution without changing model selections", () => {
  const parsed = parseFuseArgs([...panel, "--writer", "c/model", "--executor", "llm", "task"]);
  assert.equal(parsed.executor, "llm");
  assert.deepEqual(parsed.models, ["a/model", "b/model"]);
  assert.equal(parsed.writer, "c/model");
  assert.throws(() => parseFuseArgs([...panel, "--writer", "c/model", "--executor", "shell", "task"]), /executor/);
});


test("fuse CLI supports an explicit OAuth writer executor override", () => {
  const parsed = parseFuseArgs([...panel, "--writer", "c/model", "--executor", "llm", "--writer-executor", "opencode", "task"]);
  assert.equal(parsed.executor, "llm");
  assert.equal(parsed.writerExecutor, "opencode");
});
