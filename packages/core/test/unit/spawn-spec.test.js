import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SPAWN_OPTIONS, createSpawnOptions } from "../../src/index.js";

test("createSpawnOptions provides the canonical defaults", () => {
  const options = createSpawnOptions();
  assert.deepEqual(options, DEFAULT_SPAWN_OPTIONS);
  assert.notStrictEqual(options.readGrants, DEFAULT_SPAWN_OPTIONS.readGrants);
  assert.notStrictEqual(options.writeGrants, DEFAULT_SPAWN_OPTIONS.writeGrants);
  assert.notStrictEqual(options.bashAllow, DEFAULT_SPAWN_OPTIONS.bashAllow);
});

test("createSpawnOptions preserves extensions without sharing grant arrays", () => {
  const options = createSpawnOptions({ readGrants: ["./docs"], graphId: "relay" });
  options.readGrants.push("./src");
  assert.deepEqual(options.readGrants, ["./docs", "./src"]);
  assert.equal(options.graphId, "relay");
});
