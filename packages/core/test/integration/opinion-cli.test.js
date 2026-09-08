import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseOpinionArgs, readOpinionContext } from "../../../cli/src/commands/work.js";

test("opinion CLI requires a distinct multi-model panel and parses bounded controls", () => {
  assert.deepEqual(
    parseOpinionArgs([
      "--model", "alpha/reviewer",
      "--model", "beta/reviewer",
      "--context", "src/engine.js",
      "--max-tokens", "600",
      "--concurrency", "2",
      "--json",
      "Review the authority boundary",
    ]),
    {
      help: false,
      task: "Review the authority boundary",
      models: ["alpha/reviewer", "beta/reviewer"],
      contextFiles: ["src/engine.js"],
      maxTokens: 600,
      concurrency: 2,
      json: true,
    },
  );
  assert.throws(
    () => parseOpinionArgs(["--model", "alpha/reviewer", "only one reviewer"]),
    /between 2 and 5 --model values/,
  );
  assert.throws(
    () => parseOpinionArgs(["--model", "alpha/reviewer", "--model", "alpha/reviewer", "duplicate"]),
    /must be distinct/,
  );
});

test("opinion context is regular, bounded, and contained in the mind project", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-opinion-cli-"));
  const outside = mkdtempSync(path.join(tmpdir(), "mind-opinion-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs", "brief.md"), "The API has no deadline.");
  writeFileSync(path.join(outside, "secret.md"), "outside");

  assert.match(readOpinionContext(root, ["docs/brief.md"]), /### docs\/brief\.md/);
  assert.throws(() => readOpinionContext(root, [path.join(outside, "secret.md")]), /outside the mind project/);
  assert.throws(() => readOpinionContext(root, ["docs"]), /not a regular file/);
});
