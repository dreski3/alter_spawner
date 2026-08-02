import test from "node:test";
import assert from "node:assert/strict";
import { checkOutputContract, validateOutputContract } from "../../src/index.js";

test("output contracts support exact, prefix, regex, and JSON results", () => {
  assert.equal(checkOutputContract(" SECRET:value\n", { type: "prefix", value: "SECRET:" }).ok, true);
  assert.equal(checkOutputContract("done", { type: "exact", value: "done" }).ok, true);
  assert.equal(checkOutputContract("HANDLE:id:ENCODING:hex", { type: "regex", pattern: "^HANDLE:" }).ok, true);
  assert.equal(checkOutputContract('{"ok":true}', { type: "json" }).ok, true);
});

test("output contracts reject semantic error text", () => {
  const result = checkOutputContract("tool call failed", { type: "prefix", value: "SECRET:" });
  assert.equal(result.ok, false);
  assert.match(result.error, /prefix contract/);
});

test("invalid output contracts fail validation", () => {
  assert.throws(() => validateOutputContract({ type: "regex", pattern: "[" }), /pattern is invalid/);
  assert.throws(() => validateOutputContract({ type: "prefix" }), /value must be a string/);
});
