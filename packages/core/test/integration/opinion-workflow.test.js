import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOpinionGraph, registerHarness, runOpinion } from "@mind/core";

const response = (text) => ({
  tokens: { input: 3, output: 2, reasoning: 0, cache_read: 0, total: 5 },
  text,
  sessionID: null,
  steps: 1,
  exitCode: 0,
  killed: false,
  ok: true,
  budget_exceeded: false,
  empty_output: false,
});

test("opinion runs independent tool-free reviewers and preserves their labeled results", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-opinion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "unused/default",
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  const seen = [];
  registerHarness("opinion-workflow", {
    async run(home, prompt, options) {
      seen.push({ home, prompt, options });
      return response(`opinion from ${options.model}`);
    },
  });

  const outcome = await runOpinion(root, {
    task: "Should this API expose an explicit deadline?",
    models: ["alpha/reviewer", "beta/reviewer"],
    context: "The current API accepts AbortSignal but not a deadline.",
    maxTokens: 400,
  }, { harness: "opinion-workflow" });

  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.node_counts.succeeded, 2);
  assert.equal(outcome.result.tokens.total, 10);
  assert.deepEqual(outcome.opinions, [
    { model: "alpha/reviewer", state: "succeeded", text: "opinion from alpha/reviewer", error: null },
    { model: "beta/reviewer", state: "succeeded", text: "opinion from beta/reviewer", error: null },
  ]);
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.match(call.prompt, /Should this API expose an explicit deadline\?/);
    assert.match(call.prompt, /current API accepts AbortSignal/);
    assert.equal(call.options.maxTokens, 400);
    const alter = JSON.parse(readFileSync(path.join(call.home, "alter.json"), "utf8"));
    assert.equal(alter.text_only, true);
    assert.equal(alter.web, false);
    assert.deepEqual(alter.read_grants, []);
    assert.deepEqual(alter.write_grants, []);
  }
});

test("opinion accepts only a distinct 2-5 model panel", () => {
  assert.throws(() => buildOpinionGraph({ task: "x", models: ["one/model"] }), /between 2 and 5 models/);
  assert.throws(() => buildOpinionGraph({ task: "x", models: ["one/model", "one/model"] }), /must be distinct/);
  assert.throws(() => buildOpinionGraph({ task: "", models: ["one/model", "two/model"] }), /requires a task/);
});
