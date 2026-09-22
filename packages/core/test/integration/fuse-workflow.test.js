import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFuseGraph, registerHarness, runFuse } from "@mind/core";
import { formatFuse } from "../../../cli/src/commands/work.js";

const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-fuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({ default_model: "forbidden/default", default_fallback_model: "forbidden/fallback", retry: { same_harness_retries: 0, fallback_retries: 1 } }));
  return root;
};
const options = { task: "Implement deadlines", models: ["a/model", "b/model"], writer: "c/model", context: "Explicit context only", maxTokens: 200 };
const response = (text) => ({ text, tokens: { input: 3, output: 2, reasoning: 0, cache_read: 0, total: 5 }, steps: 1, exitCode: 0, killed: false, ok: true, budget_exceeded: false, empty_output: false });

test("fuse isolates parallel analysts, then joins their outputs in the explicit writer", async (t) => {
  const root = fixture(t);
  const seen = [];
  let active = 0;
  let peak = 0;
  let completed = 0;
  registerHarness("fuse-success", { async run(home, prompt, opts) {
    seen.push({ home, prompt, opts });
    if (opts.model === "c/model") {
      assert.equal(completed, 2);
      assert.match(prompt, /analyst_1 \(a\/model\)/);
      assert.match(prompt, /proposal a\/model/);
      assert.match(prompt, /proposal b\/model/);
      return response("Implementation: propagate the deadline.");
    }
    assert.doesNotMatch(prompt, /proposal [ab]\/model/);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    completed++;
    return response(`proposal ${opts.model}`);
  } });
  const outcome = await runFuse(root, options, { harness: "fuse-success" });
  assert.equal(peak, 2);
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.tokens.total, 15);
  assert.equal(new Set(seen.map((call) => call.home)).size, 3);
  for (const { home, prompt, opts } of seen) {
    assert.match(prompt, /Explicit context only/);
    assert.equal(opts.maxTokens, 200);
    const alter = JSON.parse(readFileSync(path.join(home, "alter.json")));
    assert.equal(alter.text_only, true);
    assert.equal(alter.web, false);
    assert.deepEqual(alter.read_grants, []);
    assert.deepEqual(alter.write_grants, []);
    assert.equal(alter.fallback_model, opts.model);
  }
  assert.equal(readFileSync(outcome.answer, "utf8"), "Implementation: propagate the deadline.\n");
  const report = JSON.parse(readFileSync(outcome.report.json));
  assert.equal(report.workflow, "fuse");
  assert.equal(report.nodes[2].role, "writer");
  assert.equal(report.totals.nodes, 3);
  assert.match(formatFuse(outcome), /Implementation: propagate the deadline/);
  assert.match(formatFuse(outcome), /3 in · 2 out · 0 reasoning · 0 cached/);
  assert.match(formatFuse(outcome), /Dashboard.*fuse.html/);
  assert.match(readFileSync(outcome.report.html, "utf8"), /Synthesized implementation answer/);
  assert.match(formatFuse(outcome), /not a subscription invoice/);
});

test("fuse skips the writer on analyst failure without using configured fallback models", async (t) => {
  const root = fixture(t);
  const calls = [];
  registerHarness("fuse-failure", { async run(_home, _prompt, opts) {
    calls.push(opts.model);
    return opts.model === "a/model" ? { ...response(""), ok: false, exitCode: 1, empty_output: true } : response("analysis");
  } });
  const outcome = await runFuse(root, options, { harness: "fuse-failure" });
  assert.deepEqual(calls.sort(), ["a/model", "b/model"]);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.writer.state, "skipped");
  assert.equal(outcome.answer, null);
  assert.match(formatFuse(outcome), /Synthesis unavailable: dependency/);
});

test("fuse records bounded writer edges and preserves full analyst results", async (t) => {
  const root = fixture(t);
  registerHarness("fuse-truncated", { async run(_home, prompt, opts) {
    if (opts.model === "c/model") {
      assert.match(prompt, /truncated: 32000 of 33000 characters/);
      return response("bounded synthesis");
    }
    return response("x".repeat(33000));
  } });
  const outcome = await runFuse(root, options, { harness: "fuse-truncated" });
  assert.equal(outcome.result.nodes.writer.truncated_edges.length, 2);
  assert.equal(outcome.analysts[0].text.length, 33000);
});

test("fuse validates explicit models, context, and budget before dispatch", () => {
  for (const writer of [undefined, "", "model", "provider/", "a/white space"]) assert.throws(() => buildFuseGraph({ ...options, writer }), /writer/);
  assert.throws(() => buildFuseGraph({ ...options, models: ["a/model"] }), /between 2 and 5/);
  assert.throws(() => buildFuseGraph({ ...options, models: ["a/model", "a/model"] }), /distinct/);
  assert.throws(() => buildFuseGraph({ ...options, maxTokens: NaN }), /positive integer/);
  assert.throws(() => buildFuseGraph({ ...options, task: " " }), /requires a task/);
  assert.throws(() => buildFuseGraph({ ...options, context: {} }), /context must be a string/);
  assert.equal(buildFuseGraph({ ...options, writer: "a/model" }).nodes.at(-1).model, "a/model");
});

test("fuse respects serial execution, prices retries, and reports writer failure", async (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({ retry: { same_harness_retries: 1, fallback_retries: 1 }, default_fallback_model: "forbidden/fallback" }));
  const catalog = path.join(root, "models.json");
  writeFileSync(catalog, JSON.stringify(Object.fromEntries(["a", "b", "c"].map((id) => [id, { models: { model: { cost: { input: 1, output: 2, cache_read: 0 } } } }]))));
  let active = 0;
  let peak = 0;
  const calls = [];
  registerHarness("fuse-writer-failure", { async run(_home, _prompt, opts) {
    calls.push(opts.model);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return opts.model === "c/model" ? { ...response("failed draft"), ok: false, exitCode: 1 } : response("analysis");
  } });
  const outcome = await runFuse(root, options, { harness: "fuse-writer-failure", concurrency: 1, env: { OPENCODE_MODELS_PATH: catalog } });
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["a/model", "b/model", "c/model", "c/model"]);
  assert.equal(outcome.writer.state, "failed");
  assert.equal(outcome.answer, null);
  assert.equal(outcome.result.tokens.total, 20);
  assert.equal(outcome.report.report.nodes[2].attempts, 2);
  assert.equal(outcome.report.report.nodes[2].estimated_api_cost_usd, 0.000014);
  assert.equal(outcome.report.report.totals.estimated_api_cost_usd, 0.000028);
  assert.doesNotMatch(formatFuse(outcome), /failed draft/);
  await assert.rejects(runFuse(root, options, { concurrency: NaN }), /concurrency/);
});

test("fuse applies an explicit tool-free executor to all graph nodes", () => {
  const graph = buildFuseGraph({ ...options, executor: "llm" });
  for (const node of graph.nodes) {
    assert.equal(node.executor, "llm");
    assert.equal(node.textOnly, true);
    assert.equal(node.fallbackModel, node.model);
  }
  assert.throws(() => buildFuseGraph({ ...options, executor: "shell" }), /executor/);
});


test("fuse can route direct analysts and an OAuth writer through different executors", () => {
  const graph = buildFuseGraph({ ...options, executor: "codex", writerExecutor: "opencode" });
  assert.deepEqual(graph.nodes.map((node) => node.executor), ["codex", "codex", "opencode"]);
  assert.throws(() => buildFuseGraph({ ...options, writerExecutor: "shell" }), /writerExecutor/);
});
