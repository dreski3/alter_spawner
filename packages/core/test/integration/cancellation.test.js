import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  parseSpawnArgs,
  registerHarness,
  spawnAlter,
} from "@mind/core";

const root = mkdtempSync(path.join(os.tmpdir(), "mind-cancel-"));

after(() => rmSync(root, { recursive: true, force: true }));

test("passes cancellation to the harness and does not retry an aborted run", async () => {
  let calls = 0;
  let receivedSignal;
  registerHarness("cancellation-test", {
    async run(_home, _prompt, options) {
      calls++;
      receivedSignal = options.signal;
      return {
        tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
        text: "",
        sessionID: null,
        steps: 0,
        exitCode: null,
        killed: true,
        aborted: true,
        ok: false,
        budget_exceeded: false,
        empty_output: false,
      };
    },
  });
  const controller = new AbortController();
  controller.abort();
  const options = parseSpawnArgs([
    "--name",
    "cancelled-specialist",
    "--description",
    "A cancellation test Alter.",
    "--model",
    "test/model",
    "--prompt",
    "Do not run.",
  ]);
  const output = await spawnAlter(root, options, {
    harness: "cancellation-test",
    signal: controller.signal,
  });

  assert.equal(output.created, false);
  assert.equal(calls, 1);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(output.result.aborted, true);
  assert.equal(output.result.attempts.length, 1);
});
