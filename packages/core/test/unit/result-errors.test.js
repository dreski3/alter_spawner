import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeResult } from "@mind/core";

test("persisted run results preserve actionable executor errors for graph propagation", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-result-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".alters", "runs", "failed-node");
  mkdirSync(home, { recursive: true });
  const result = writeResult(root, home, {
    id: "failed-node", maxTokens: 1000, model: "openai/example", executor: "llm",
    catalogName: "example", depth: 0, spawned_by: "graph:test", graphId: "test",
    dependsOn: [], outputContract: null, imageMetadata: [],
  }, {
    ok: false, exitCode: 1, killed: false, text: "", steps: 0, sessionID: null,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
    llm_error: "OpenAI OAuth is unavailable to the direct adapter",
    capability_error: null,
  }, "2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.001Z", 1, []);
  assert.equal(result.llm_error, "OpenAI OAuth is unavailable to the direct adapter");
  assert.equal(result.capability_error, null);
});
