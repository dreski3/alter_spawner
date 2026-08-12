// Covers empty-output retry end-to-end through the real spawn path (scaffold -> attempt
// plan -> result.json) with the harness faked via `registerHarness`, so it runs
// offline with no model and no `opencode` binary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHarness, spawnAlter } from "@mind/core";
import { classify } from "../../src/harness/opencode.js";

const MODEL = "fake/primary";
const FALLBACK = "fake/fallback";

// Replies with whatever the script says for each successive attempt, shaped like
// a real adapter result (classify() supplies ok/empty_output/budget_exceeded, so
// the fake can't drift from the contract the real adapter follows).
const fakeHarness = (texts) => {
  const calls = [];
  const run = (home, prompt, opts) => {
    const text = texts[Math.min(calls.length, texts.length - 1)];
    calls.push({ home, prompt, opts });
    return Promise.resolve({
      tokens: { input: 10, output: text ? 5 : 1, reasoning: 0, cache_read: 0, total: 11 },
      text,
      sessionID: "fake-session",
      steps: 2,
      exitCode: 0,
      killed: false,
      ...classify({ exitCode: 0, killed: false, budgetExceeded: false, text }),
    });
  };
  return { adapter: { run }, calls };
};

const makeProject = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-empty-"));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({
      default_model: MODEL,
      max_depth: 5,
      run_timeout_ms: 5000,
      catalog_dir: "catalog",
      default_fallback_model: FALLBACK,
      retry: { same_harness_retries: 1, fallback_retries: 1 },
    })
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const spawnOpts = (prompt) => ({
  name: "empty-probe",
  description: "test alter",
  model: MODEL,
  readGrants: [],
  writeGrants: [],
  bashAllow: [],
  mindBinPath: "/fake/mind",
  prompt,
});

test("an empty result is retried and the recovered attempt wins", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = fakeHarness(["", "", "recovered on the fallback"]);
  registerHarness("fake-recovers", adapter);

  const { home, result } = await spawnAlter(root, spawnOpts("do the thing"), {
    harness: "fake-recovers",
  });

  assert.equal(calls.length, 3, "should exhaust same-model retry, then escalate");
  assert.deepEqual(
    result.attempts.map((a) => [a.reason, a.model, a.empty_output]),
    [
      ["initial", MODEL, true],
      ["retry_same_model", MODEL, true],
      ["retry_fallback_model", FALLBACK, false],
    ]
  );
  assert.equal(result.ok, true);
  assert.equal(result.empty_output, false, "the final, non-empty attempt decides the outcome");
  assert.equal(result.model, FALLBACK);
  assert.equal(result.text, "recovered on the fallback");

  const onDisk = JSON.parse(readFileSync(path.join(home, "result.json"), "utf8"));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.empty_output, false);
  assert.equal(readFileSync(path.join(home, "result.md"), "utf8").trim(), "recovered on the fallback");
});

test("an always-empty run is recorded as a failure, not a silent success", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = fakeHarness([""]);
  registerHarness("fake-always-empty", adapter);

  const { home, result } = await spawnAlter(root, spawnOpts("do the thing"), {
    harness: "fake-always-empty",
  });

  assert.equal(calls.length, 3, "every tier should be spent before giving up");
  assert.equal(result.ok, false, "empty output used to be recorded as ok:true");
  assert.equal(result.empty_output, true);
  assert.equal(result.exit_code, 0, "the underlying process really did exit cleanly");
  assert.equal(result.killed, false);
  assert.equal(result.budget_exceeded, false, "an empty result is not a budget overrun");
  assert.ok(
    result.attempts.every((a) => a.empty_output === true),
    "each attempt should record its own empty_output"
  );

  const onDisk = JSON.parse(readFileSync(path.join(home, "result.json"), "utf8"));
  assert.equal(onDisk.empty_output, true);
  assert.equal(onDisk.ok, false);
  assert.equal(readFileSync(path.join(home, "result.md"), "utf8").trim(), "(no output)");
});

test("a non-empty first attempt still short-circuits the plan", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = fakeHarness(["straight away"]);
  registerHarness("fake-succeeds", adapter);

  const { result } = await spawnAlter(root, spawnOpts("do the thing"), { harness: "fake-succeeds" });

  assert.equal(calls.length, 1, "no retries for a run that already returned something");
  assert.equal(result.ok, true);
  assert.equal(result.empty_output, false);
  assert.equal(result.model, MODEL);
});

test("a semantic contract failure retries until a valid result arrives", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = fakeHarness(["tool call failed", "SECRET:recovered"]);
  registerHarness("fake-contract-recovers", adapter);

  const options = {
    ...spawnOpts("recover the secret"),
    outputContract: { type: "prefix", value: "SECRET:" },
  };
  const { result } = await spawnAlter(root, options, { harness: "fake-contract-recovers" });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.contract_failed, false);
  assert.equal(result.text, "SECRET:recovered");
  assert.equal(result.attempts[0].contract_failed, true);
  assert.match(result.attempts[0].contract_error, /prefix contract/);
  assert.equal(result.attempts[1].contract_failed, false);
});
