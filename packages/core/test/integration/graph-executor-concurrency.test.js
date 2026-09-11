import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHarness, runAlterGraph } from "@mind/core";

const response = (text) => ({
  text,
  tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
  sessionID: null,
  steps: 1,
  exitCode: 0,
  killed: false,
  ok: true,
  budget_exceeded: false,
  empty_output: false,
});

test("executor lanes serialize SQLite-backed work without reducing direct concurrency", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-executor-lanes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({
    default_model: "test/model",
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));

  let totalActive = 0;
  let totalPeak = 0;
  let lockedActive = 0;
  let lockedPeak = 0;
  let directActive = 0;
  let directPeak = 0;
  const adapter = (kind) => ({
    needsAgentHome: false,
    async run() {
      totalPeak = Math.max(totalPeak, ++totalActive);
      if (kind === "locked") lockedPeak = Math.max(lockedPeak, ++lockedActive);
      else directPeak = Math.max(directPeak, ++directActive);
      await new Promise((resolve) => setTimeout(resolve, 30));
      totalActive--;
      if (kind === "locked") lockedActive--;
      else directActive--;
      return response(kind);
    },
  });
  registerHarness("lane-locked", adapter("locked"));
  registerHarness("lane-direct", adapter("direct"));

  const { result } = await runAlterGraph(root, {
    id: "executor-lanes",
    nodes: [
      { id: "locked-1", prompt: "one", executor: "lane-locked", textOnly: true },
      { id: "locked-2", prompt: "two", executor: "lane-locked", textOnly: true },
      { id: "direct-1", prompt: "three", executor: "lane-direct", textOnly: true },
      { id: "direct-2", prompt: "four", executor: "lane-direct", textOnly: true },
    ],
  }, { concurrency: 3, executorConcurrency: { "lane-locked": 1 } });

  assert.equal(result.ok, true);
  assert.equal(lockedPeak, 1, "the shared-store executor must not overlap with itself");
  assert.equal(directPeak, 2, "independent direct requests should overlap");
  assert.equal(totalPeak, 3, "waiting locked work must not occupy a global slot");
});
