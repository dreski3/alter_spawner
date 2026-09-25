import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeRunTree } from "../../src/index.js";

const tokens = (input, output) => ({ input, output, reasoning: 0, cache_read: 0, total: input + output });

const writeRun = (home, depth, attempts, decision = null, treeId = null) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "result.json"), JSON.stringify({ depth, tree_id: treeId, attempts, tokens: attempts.at(-1).tokens }));
  if (decision) writeFileSync(path.join(home, "decision.json"), JSON.stringify(decision));
};

test("run tree usage counts retries and deeply nested children once", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-tree-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, ".alters", "runs", "parent");
  const child = path.join(parent, ".alters", "runs", "child");
  const grandchild = path.join(child, ".alters", "runs", "grandchild");
  const routed = path.join(root, ".alters", "runs", "routed");
  const attempt = (model, input, output) => ({ model, executor: "llm", tokens: tokens(input, output) });
  writeRun(parent, 0, [attempt("priced/a", 10, 2), attempt("priced/b", 20, 3)], {
    child_home: path.relative(root, child),
  });
  writeRun(child, 1, [attempt("priced/a", 5, 1)]);
  writeRun(grandchild, 2, [attempt("priced/a", 7, 1)], {
    adviser: "local-choice",
    child_home: path.relative(root, routed),
  });
  writeRun(routed, 3, [attempt("priced/a", 11, 2)]);
  const summary = summarizeRunTree(root, parent, { providers: {
    priced: { models: {
      a: { cost: { input_per_million: 1, output_per_million: 2 } },
      b: { cost: { input_per_million: 3, output_per_million: 4 } },
    } },
  } });
  assert.equal(summary.runs, 4);
  assert.equal(summary.attempts, 5);
  assert.equal(summary.max_depth, 3);
  assert.deepEqual(summary.tokens, tokens(53, 9));
  assert.equal(summary.priced_cost_usd, 0.000117);
  assert.equal(summary.estimated_api_cost_usd, null);
  assert.equal(summary.unpriced_attempts, 0);
  assert.equal(summary.unreported_adviser_decisions, 1);
});

test("run tree usage keeps unknown prices distinct from zero cost", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-tree-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".alters", "runs", "one");
  writeRun(home, 0, [
    { model: "local/model", executor: "llm", tokens: tokens(3, 2) },
    { model: "unknown/model", executor: "llm", tokens: tokens(4, 1) },
  ]);
  const summary = summarizeRunTree(root, home, { providers: {
    local: { cost: { input_per_million: 0, output_per_million: 0 } },
  } });
  assert.equal(summary.priced_cost_usd, 0);
  assert.equal(summary.unpriced_attempts, 1);
  assert.equal(summary.estimated_api_cost_usd, null);
});

test("run tree usage prices cached tokens according to provider token totals", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-tree-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".alters", "runs", "one");
  const pricing = { cost: { input_per_million: 1, output_per_million: 2, cache_read_per_million: 0.25 } };
  writeRun(home, 0, [
    { model: "priced/model", executor: "llm", tokens: { input: 100, output: 10, reasoning: 0, cache_read: 40, total: 110 }, pricing },
    { model: "priced/model", executor: "opencode", tokens: { input: 60, output: 10, reasoning: 0, cache_read: 40, total: 110 }, pricing },
  ]);
  const summary = summarizeRunTree(root, home);
  assert.equal(summary.priced_cost_usd, 0.00018);
  assert.equal(summary.estimated_api_cost_usd, 0.00018);
});

test("run tree usage excludes children from an earlier rerun", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-tree-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, ".alters", "runs", "parent");
  const current = path.join(parent, ".alters", "runs", "current");
  const earlier = path.join(parent, ".alters", "runs", "earlier");
  const attempt = { model: "local/model", executor: "llm", tokens: tokens(1, 1) };
  writeRun(parent, 0, [attempt], null, "tree-current");
  writeRun(current, 1, [attempt], null, "tree-current");
  writeRun(earlier, 1, [attempt], null, "tree-earlier");
  const summary = summarizeRunTree(root, parent, { providers: {
    local: { cost: { input_per_million: 0, output_per_million: 0 } },
  } });
  assert.equal(summary.runs, 2);
  assert.equal(summary.tokens.total, 4);
  assert.equal(summary.estimated_api_cost_usd, 0);
});

test("run tree usage separates missing token reports, missing prices, and parallel node time", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-tree-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, ".alters", "runs", "parent");
  const child = path.join(parent, ".alters", "runs", "child");
  writeRun(parent, 0, [
    { model: "local/unknown", executor: "llm", tokens: tokens(0, 0) },
    { model: "local/unknown", executor: "llm", tokens: tokens(3, 1), pricing: { cost: null } },
  ], null, "tree-one");
  writeRun(child, 1, [{ model: "local/free", executor: "llm", tokens: tokens(2, 1), pricing: {
    cost: { input_per_million: 0, output_per_million: 0, cache_read_per_million: null },
  } }], null, "tree-one");
  const parentResult = JSON.parse(readFileSync(path.join(parent, "result.json"), "utf8"));
  parentResult.timing = { wall_duration_ms: 10 };
  writeFileSync(path.join(parent, "result.json"), JSON.stringify(parentResult));
  const childResult = JSON.parse(readFileSync(path.join(child, "result.json"), "utf8"));
  childResult.timing = { wall_duration_ms: 20 };
  writeFileSync(path.join(child, "result.json"), JSON.stringify(childResult));
  const summary = summarizeRunTree(root, parent);
  assert.equal(summary.missing_token_usage_attempts, 1);
  assert.equal(summary.missing_price_attempts, 1);
  assert.equal(summary.unpriced_attempts, 2);
  assert.equal(summary.estimated_api_cost_usd, null);
  assert.equal(summary.tree_wall_duration_ms, 10);
  assert.equal(summary.summed_node_wall_duration_ms, 30);
});
