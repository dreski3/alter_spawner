// The guards as a spawner actually meets them: enforced through spawnAlter, carried
// between levels by the environment, and visible in the graph trace when they fire.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntime,
  DEFAULT_MAX_EDGE_CHARS,
  readTreeLedger,
  registerHarness,
  renderGraphPrompt,
  runAlterGraph,
  spawnAlter,
  treeLedgerPath,
  validateGraph,
} from "@mind/core";

const makeProject = (t, config = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-guards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ default_model: "test/model", retry: { same_harness_retries: 0, fallback_retries: 0 }, ...config }),
  );
  return root;
};

const seen = [];
registerHarness("guard-stub", {
  async run(home, prompt, options) {
    seen.push({ prompt, environment: options.environment });
    return {
      tokens: { input: 40, output: 10, reasoning: 0, cache_read: 0, total: 50 },
      text: "x".repeat(200),
      sessionID: null,
      steps: 1,
      exitCode: 0,
      killed: false,
      ok: true,
      budget_exceeded: false,
      empty_output: false,
    };
  },
});

const spawn = (root, name, extra = {}) =>
  spawnAlter(root, { name, prompt: "work", readGrants: [], writeGrants: [], bashAllow: [] }, { harness: "guard-stub", ...extra });

// A tree is rooted at the outermost spawn: a caller with no ALTER_TREE in its
// environment mints one, and everything below inherits it. Two unrelated requests to
// the bridge are therefore two trees with two budgets, which is the intent — the
// ceiling is on one decomposition, not on a project's lifetime. Simulating a
// descendant means handing it the environment its parent would have passed down.
const descendantOf = (parentEnvironment, overrides = {}) =>
  createRuntime({ env: { ...parentEnvironment, ...overrides } });

const rootSpawn = async (root, name) => {
  seen.length = 0;
  const spawned = await spawn(root, name);
  return { spawned, environment: seen[seen.length - 1].environment };
};

test("a tree stops at its node budget, and says which limit it hit", async (t) => {
  const root = makeProject(t, { max_tree_nodes: 2 });
  const { environment } = await rootSpawn(root, "planner");
  await spawn(root, "leaf-1", { runtime: descendantOf(environment) });
  await assert.rejects(
    () => spawn(root, "leaf-2", { runtime: descendantOf(environment) }),
    /tree node budget exhausted: 2\/2/,
  );
});

test("each top-level request is its own tree, so the ceiling is per decomposition", async (t) => {
  const root = makeProject(t, { max_tree_nodes: 1 });
  await spawn(root, "first");
  // A second, unrelated root spawn is not starved by the first one's spend.
  const second = await spawn(root, "second");
  assert.equal(second.result.ok, true);
});

test("a spawn refused by the budget leaves no orphan home behind", async (t) => {
  const root = makeProject(t, { max_tree_nodes: 1 });
  const { environment } = await rootSpawn(root, "only");
  const runsBefore = readdirSync(path.join(root, ".alters", "runs")).length;
  await assert.rejects(() => spawn(root, "refused", { runtime: descendantOf(environment) }), /node budget exhausted/);
  // Admission runs before scaffolding precisely so a refused spawn costs nothing.
  assert.equal(readdirSync(path.join(root, ".alters", "runs")).length, runsBefore);
});

test("tokens actually spent are charged to the tree", async (t) => {
  const root = makeProject(t, { max_tree_nodes: 10, max_tree_tokens: 120 });
  const { environment } = await rootSpawn(root, "planner");
  const ledgerFile = environment.ALTER_TREE_LEDGER;
  assert.equal(readTreeLedger(ledgerFile).tokens_spent, 50, "charged on release, from the run's own accounting");

  await spawn(root, "leaf-1", { runtime: descendantOf(environment) });
  assert.equal(readTreeLedger(ledgerFile).tokens_spent, 100);

  // 100 is still under 120, so this one is admitted and runs — accounting is after
  // the fact, so the guard stops the tree continuing past the line rather than
  // stopping the node that crossed it.
  await spawn(root, "leaf-2", { runtime: descendantOf(environment) });
  assert.equal(readTreeLedger(ledgerFile).tokens_spent, 150);
  await assert.rejects(
    () => spawn(root, "leaf-3", { runtime: descendantOf(environment) }),
    /tree token budget exhausted: 150\/120/,
  );
});

test("the slot is released even when a run throws", async (t) => {
  const root = makeProject(t, { max_concurrent_alters: 1 });
  registerHarness("guard-throw", {
    async run() {
      throw new Error("harness exploded");
    },
  });
  await assert.rejects(() => spawn(root, "boom", { harness: "guard-throw" }), /harness exploded/);
  // A leaked slot would wedge the next spawn until the stale timeout, and this
  // process is still alive so the pid prune would not reclaim it.
  const ok = await spawn(root, "after");
  assert.equal(ok.result.ok, true);
});

test("children inherit the tree, so the budget is one tree's rather than one level's", async (t) => {
  const root = makeProject(t, { max_tree_nodes: 8 });
  const { environment } = await rootSpawn(root, "parent");
  assert.ok(environment.ALTER_TREE, "a root spawn mints a tree id");
  assert.ok(environment.ALTER_NODE, "and its own node id, which its children will name as parent");
  assert.equal(environment.ALTER_TREE_LEDGER, treeLedgerPath(root, environment.ALTER_TREE));
  assert.ok(
    path.isAbsolute(environment.ALTER_TREE_LEDGER),
    "a nested Alter resolves .alters to its own kit, so the ledger path must be absolute",
  );

  await spawn(root, "child", { runtime: descendantOf(environment, { ALTER_ID: "parent" }) });
  const ledger = readTreeLedger(environment.ALTER_TREE_LEDGER);
  assert.equal(ledger.nodes_admitted, 2, "both landed in the same ledger");
  assert.equal(ledger.live.length, 0);
  // The child names its parent's node, which is what lets the concurrency cap tell
  // an ancestor from parallel work.
  assert.equal(seen[seen.length - 1].environment.ALTER_TREE, environment.ALTER_TREE);
});

test("with every limit off there is no ledger at all", async (t) => {
  const root = makeProject(t, { max_tree_nodes: null, max_tree_tokens: null, max_concurrent_alters: null });
  await spawn(root, "a");
  assert.equal(existsSync(path.join(root, ".alters", "trees")), false);
});

// --- edge truncation -------------------------------------------------------------

test("an oversized dependency result is truncated visibly, not silently", () => {
  const graph = validateGraph({
    nodes: [
      { id: "big", prompt: "produce" },
      { id: "consumer", depends_on: ["big"], prompt: "use {{result:big}}" },
    ],
  });
  const text = "y".repeat(100);
  const truncations = [];
  const prompt = renderGraphPrompt(graph.nodes.get("consumer"), { big: { result: { text } } }, {
    maxEdgeChars: 40,
    onTruncate: (edge) => truncations.push(edge),
  });
  assert.match(prompt, /\[truncated: 40 of 100 characters from "big"\]/);
  assert.ok(prompt.includes("y".repeat(40)));
  assert.ok(!prompt.includes("y".repeat(41)));
  assert.deepEqual(truncations, [{ from: "big", to: "consumer", kept: 40, total: 100 }]);
});

test("results under the limit pass through untouched, and null disables the guard", () => {
  const graph = validateGraph({
    nodes: [
      { id: "small", prompt: "produce" },
      { id: "consumer", depends_on: ["small"], prompt: "use {{result:small}}" },
    ],
  });
  const node = graph.nodes.get("consumer");
  assert.equal(renderGraphPrompt(node, { small: { result: { text: "short" } } }), "use short");
  const huge = "z".repeat(DEFAULT_MAX_EDGE_CHARS + 10);
  assert.equal(
    renderGraphPrompt(node, { small: { result: { text: huge } } }, { maxEdgeChars: null }),
    `use ${huge}`,
  );
  assert.match(
    renderGraphPrompt(node, { small: { result: { text: huge } } }),
    /\[truncated: 32000 of 32010 characters/,
    "the default is on",
  );
});

test("a graph records which node received a shortened input", async (t) => {
  const root = makeProject(t, { max_tree_nodes: null, max_tree_tokens: null, max_concurrent_alters: null });
  const { result } = await runAlterGraph(
    root,
    {
      id: "trunc",
      max_edge_chars: 50,
      nodes: [
        { id: "producer", prompt: "produce" },
        { id: "consumer", depends_on: ["producer"], prompt: "use {{result:producer}}" },
      ],
      output: "consumer",
    },
    { harness: "guard-stub" },
  );
  // The stub returns 200 characters, over the graph's 50-character edge limit.
  assert.equal(result.nodes.producer.truncated_edges, null);
  assert.deepEqual(result.nodes.consumer.truncated_edges, [
    { from: "producer", to: "consumer", kept: 50, total: 200 },
  ]);
});
