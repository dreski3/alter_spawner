import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as core from "@mind/core";

const declarations = readFileSync(new URL("../../src/index.d.ts", import.meta.url), "utf8");

test("every runtime export has a public TypeScript declaration", () => {
  const missing = Object.keys(core).filter((name) => {
    const declaration = new RegExp(`export (?:function|const|class|type|interface) ${name}\\b`);
    return !declaration.test(declarations);
  });
  assert.deepEqual(missing, []);
});
