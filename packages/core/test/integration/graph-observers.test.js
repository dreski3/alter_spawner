// The two observation hooks a host needs to render a graph while it runs. Without them
// runAlterGraph is opaque until it returns: the document on disk is current throughout,
// but its directory name is not known until the call resolves, so there is nothing to
// poll and nothing to subscribe to.
//
// Stub adapters, so no `opencode` process and no model.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHarness, runAlterGraph } from "@mind/core";

const stub = (label, { emit = false } = {}) => ({
  needsAgentHome: false,
  run: async (home, prompt, { onEvent } = {}) => {
    if (emit) onEvent?.({ type: "output.delta", delta: label });
    return {
      tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
      text: `${label}:${prompt.slice(-8)}`,
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

registerHarness("obs-quiet", stub("quiet"));
registerHarness("obs-loud", stub("loud", { emit: true }));

const project = (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-graph-obs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ default_model: "test/model", retry: { same_harness_retries: 0, fallback_retries: 0 } }),
  );
  return root;
};

const CHAIN = {
  id: "observed",
  output: "second",
  nodes: [
    { id: "first", prompt: "start", executor: "obs-quiet" },
    { id: "second", prompt: "continue {{result:first}}", depends_on: ["first"], executor: "obs-quiet" },
  ],
};

test("onProgress reports every node transition, in order, before the graph returns", async (t) => {
  const root = project(t);
  const seen = [];
  const { result } = await runAlterGraph(root, CHAIN, {
    onProgress: (document) => {
      seen.push(Object.fromEntries(Object.values(document.nodes).map((node) => [node.id, node.state])));
    },
  });

  // Both nodes pending, before anything has run: the snapshot a host draws its initial
  // skeleton from.
  assert.deepEqual(seen[0], { first: "pending", second: "pending" });
  // Every transition, and the terminal state last.
  assert.deepEqual(seen.at(-1), { first: "succeeded", second: "succeeded" });
  const firstStates = seen.map((snapshot) => snapshot.first);
  assert.ok(firstStates.includes("running"), "a host never saw the first node running");
  const secondStates = seen.map((snapshot) => snapshot.second);
  assert.ok(secondStates.includes("running"), "a host never saw the second node running");
  // A node cannot be observed running after it has succeeded.
  assert.ok(
    firstStates.lastIndexOf("running") < firstStates.indexOf("succeeded"),
    "states arrived out of order",
  );
  // The last thing observed is what the call returns, so a host that renders only from
  // onProgress ends up agreeing with a host that renders only from the return value.
  assert.equal(result.ok, true);
  assert.equal(result.state, "completed");
});

test("onProgress sees a failed dependency skip its dependents rather than run them", async (t) => {
  const root = project(t);
  registerHarness("obs-broken", {
    needsAgentHome: false,
    run: async () => ({
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
      text: "",
      sessionID: null,
      steps: 0,
      exitCode: 1,
      killed: false,
      ok: false,
      budget_exceeded: false,
      empty_output: false,
    }),
  });

  const seen = [];
  const { result } = await runAlterGraph(root, {
    id: "broken",
    output: "downstream",
    nodes: [
      { id: "upstream", prompt: "start", executor: "obs-broken" },
      { id: "downstream", prompt: "continue {{result:upstream}}", depends_on: ["upstream"], executor: "obs-quiet" },
    ],
  }, { onProgress: (document) => seen.push(document.nodes.downstream.state) });

  assert.equal(result.ok, false);
  assert.equal(result.nodes.upstream.state, "failed");
  assert.equal(result.nodes.downstream.state, "skipped");
  // Never ran, so it was never observed running — the distinction the trace depends on
  // to avoid reporting one failure as two.
  assert.ok(!seen.includes("running"), "a dependent of a failed node was observed running");
  assert.equal(seen.at(-1), "skipped");
});

test("onEvent forwards node events tagged with the node that produced them", async (t) => {
  const root = project(t);
  const events = [];
  await runAlterGraph(root, {
    id: "tagged",
    output: "b",
    nodes: [
      { id: "a", prompt: "start", executor: "obs-loud" },
      { id: "b", prompt: "continue {{result:a}}", depends_on: ["a"], executor: "obs-loud" },
    ],
  }, { onEvent: (event) => events.push(event) });

  // Node-level events carry no id of their own, so without the tag a host with several
  // nodes in flight cannot attribute a delta to one of them.
  assert.deepEqual(events.filter((event) => event.type === "output.delta").map((event) => event.node), ["a", "b"]);
  // retry.js emits its own attempt.started alongside whatever the adapter produces, and
  // those are tagged too — a host tracking which node is live reads that one first.
  assert.deepEqual(events.filter((event) => event.type === "attempt.started").map((event) => event.node), ["a", "b"]);
  // Nothing reaches a host untagged.
  assert.ok(events.every((event) => typeof event.node === "string"));
});

test("a throwing observer does not fail a graph whose nodes have already done the work", async (t) => {
  const root = project(t);
  const { result } = await runAlterGraph(root, CHAIN, {
    onProgress: () => { throw new Error("host bug"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.node_counts.succeeded, 2);
});
