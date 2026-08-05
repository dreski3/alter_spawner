// The shape Phase 1 exists to allow: one graph whose reasoning node runs on a coding
// harness while its leaf transformers run on something that reads nothing off disk —
// and all three still land in the same trace, indistinguishable to anything reading
// the results.
//
// Both adapters here are stubs, so no `opencode` process and no model.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHarness, runAlterGraph } from "@mind/core";

const ran = [];

const stub = (label) => ({
  run: async (home, prompt) => {
    ran.push({ label, home, prompt });
    return {
      tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
      text: `${label}:${prompt.slice(-12)}`,
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

registerHarness("opencode", stub("agent"));
registerHarness("stub-transform", { ...stub("transform"), needsAgentHome: false });

test("a graph mixes an agent node with tool-less leaves and traces them the same way", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-mixed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ default_model: "test/model", retry: { same_harness_retries: 0, fallback_retries: 0 } }),
  );

  const { home: graphHome, result } = await runAlterGraph(root, {
    id: "mixed",
    nodes: [
      { id: "planner", prompt: "decompose the document" },
      {
        id: "compress-a",
        prompt: "compress this: {{result:planner}}",
        depends_on: ["planner"],
        executor: "stub-transform",
        textOnly: true,
      },
      {
        id: "compress-b",
        prompt: "compress this: {{result:planner}}",
        depends_on: ["planner"],
        executor: "stub-transform",
        textOnly: true,
      },
      { id: "join", prompt: "merge {{result:compress-a}} and {{result:compress-b}}", depends_on: ["compress-a", "compress-b"] },
    ],
    output: "join",
  });

  assert.equal(result.state, "completed");
  assert.equal(result.ok, true, JSON.stringify(result.nodes, null, 2));
  assert.equal(result.node_counts.succeeded, 4);
  assert.deepEqual(
    ran.map((r) => r.label),
    ["agent", "transform", "transform", "agent"],
    "each node ran on the executor it declared, not on the graph's default",
  );

  const nodes = result.nodes;
  for (const id of ["planner", "compress-a", "compress-b", "join"]) {
    assert.ok(nodes[id], `${id} is missing from the graph trace`);
    assert.equal(nodes[id].state, "succeeded");
  }
  assert.equal(nodes["compress-a"].result.executor, "stub-transform");
  assert.equal(nodes.planner.result.executor, "opencode");

  // The leaf transformers cost a folder and two JSON files; the agent nodes cost a
  // scaffolded home. Both are readable by `mind show` and both are in result.json.
  for (const id of ["compress-a", "compress-b"]) {
    const home = nodes[id].home;
    assert.ok(existsSync(path.join(home, "alter.json")), `${id} must still have a record`);
    assert.ok(existsSync(path.join(home, "result.json")));
    assert.ok(!existsSync(path.join(home, "AGENTS.md")), `${id} should not have been scaffolded`);
    assert.ok(!existsSync(path.join(home, ".opencode")));
  }
  assert.ok(existsSync(path.join(nodes.planner.home, "AGENTS.md")));
  assert.ok(existsSync(path.join(nodes.planner.home, ".opencode", "agents", "alter.md")));

  // Dependency interpolation is executor-blind: the join node received text produced
  // by an adapter that never had a home to read.
  const join = ran[ran.length - 1];
  assert.match(join.prompt, /transform:/);

  const persisted = JSON.parse(readFileSync(path.join(graphHome, "result.json"), "utf8"));
  assert.equal(persisted.output_node, "join");
  assert.equal(persisted.output, nodes.join.result.text);
  // Token accounting spans both executors rather than only the ones with homes.
  assert.equal(persisted.tokens.total, 8);
});
