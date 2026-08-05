import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CAPABILITY_TOKEN_ENV,
  CAPABILITY_URL_ENV,
  createRuntime,
  registerHarness,
  spawnAlter,
} from "@mind/core";

test("spawn execution uses the injected clock, identifiers, and environment", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "config/default",
    max_depth: 5,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));

  const environment = {
    ALTER_MODEL: "runtime/model",
    ALTER_DEPTH: "1",
    ALTER_ID: "parent-alter",
    // A capability grant belonging to the turn above this spawn. An Alter is a
    // sandbox and must not inherit it, so it should not survive the trip down.
    [CAPABILITY_URL_ENV]: "http://127.0.0.1:8788/capability",
    [CAPABILITY_TOKEN_ENV]: "tok_parent_turn",
  };
  const runtime = createRuntime({
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    randomId: (length) => "abcdef123456".slice(0, length),
    env: environment,
  });
  const calls = [];
  registerHarness("runtime-test", {
    async run(home, prompt, options) {
      calls.push({ home, prompt, options });
      return {
        tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
        text: "done",
        sessionID: "runtime-session",
        steps: 1,
        exitCode: 0,
        killed: false,
        ok: true,
        budget_exceeded: false,
        empty_output: false,
      };
    },
  });

  const { home, result } = await spawnAlter(root, {
    name: null,
    prompt: "work",
    readGrants: [],
    writeGrants: [],
    bashAllow: [],
  }, { harness: "runtime-test", runtime });

  assert.equal(path.basename(home), "20260102T030405Z_alter_abcdef");
  assert.equal(result.id, "alter_abcdef");
  assert.equal(result.model, "runtime/model");
  assert.equal(result.depth, 2);
  assert.equal(result.spawned_by, "parent-alter");
  assert.equal(result.started_at, "2026-01-02T03:04:05.000Z");
  assert.equal(result.duration_ms, 0);
  // The capability grant is gone (an Alter is a sandbox and must not inherit the
  // turn's privilege), and the tree context has been added: anything this Alter
  // spawns has to find the same ledger, or its budget and concurrency guards would
  // be enforced once per branch instead of once per tree.
  assert.deepEqual(calls[0].options.environment, {
    ALTER_MODEL: "runtime/model",
    ALTER_DEPTH: "1",
    ALTER_ID: "parent-alter",
    ALTER_TREE: "tree_abcdef12",
    ALTER_NODE: "abcdef123456",
    ALTER_TREE_LEDGER: path.join(root, ".alters", "trees", "tree_abcdef12.json"),
  });
  const alter = JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
  assert.equal(alter.created_at, "2026-01-02T03:04:05.000Z");
});
