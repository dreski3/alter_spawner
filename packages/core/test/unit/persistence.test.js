import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../../src/index.js";

test("atomic persistence replaces text and JSON without leaving temporary files", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mind-persistence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const textFile = path.join(directory, "result.md");
  const jsonFile = path.join(directory, "result.json");

  writeTextAtomic(textFile, "first\n");
  writeTextAtomic(textFile, "second\n");
  writeJsonAtomic(jsonFile, { schema_version: 1, ok: true });

  assert.equal(readFileSync(textFile, "utf8"), "second\n");
  assert.deepEqual(JSON.parse(readFileSync(jsonFile, "utf8")), { schema_version: 1, ok: true });
  assert.deepEqual(readdirSync(directory).sort(), ["result.json", "result.md"]);
});
