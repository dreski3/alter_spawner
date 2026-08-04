// The full taxonomy in one graph: a reasoning node on a coding harness, a
// deterministic transformer that never calls a model, and an approval-gated host
// operation. All three have to land in the same trace and be indistinguishable to
// anything reading the results — that is what makes them all "Alters".

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCapabilityApprovalSession,
  createCapabilityExecutor,
  createCapabilityRegistry,
  createFunctionExecutor,
  createSpawnOptions,
  registerHarness,
  runAlterGraph,
  spawnAlter,
} from "@mind/core";

const registry = createCapabilityRegistry({
  definitions: [
    {
      id: "text.compress",
      name: "Compress",
      description: "Drops vowels. Deterministic.",
      approval: "never",
      inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string", maxLength: 5000 } } },
      handler: ({ input }) => input.text.replace(/[aeiou]/g, ""),
    },
    {
      id: "text.explode",
      name: "Explode",
      description: "Always fails, to check the attempt plan.",
      approval: "never",
      inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string", maxLength: 5000 } } },
      handler: () => {
        throw new Error("deterministic failure");
      },
    },
    {
      id: "host.publish",
      name: "Publish",
      description: "Needs the user to agree.",
      approval: "always",
      inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string", maxLength: 5000 } } },
      handler: ({ input }) => `published: ${input.text}`,
    },
  ],
});

let decision = "allow-once";
const createSession = ({ catalogId, signal }) => {
  const session = createCapabilityApprovalSession({
    registry,
    catalogId,
    signal,
    onEvent: (event) => {
      if (event.type === "capability.approval_required") {
        queueMicrotask(() => session.decide(event.approval.id, decision));
      }
    },
  });
  return session;
};

registerHarness("agent-stub", {
  async run() {
    return {
      tokens: { input: 900, output: 100, reasoning: 0, cache_read: 0, total: 1000 },
      text: "a planned decomposition",
      sessionID: "s1",
      steps: 4,
      exitCode: 0,
      killed: false,
      ok: true,
      budget_exceeded: false,
      empty_output: false,
    };
  },
});
registerHarness("agent-flaky", {
  async run() {
    return {
      tokens: { input: 10, output: 0, reasoning: 0, cache_read: 0, total: 10 },
      text: "",
      sessionID: null,
      steps: 1,
      exitCode: 0,
      killed: false,
      ok: false,
      budget_exceeded: false,
      empty_output: true,
    };
  },
});
registerHarness("function", createFunctionExecutor({ registry }));
registerHarness("capability", createCapabilityExecutor({ registry, createSession }));

const makeProject = (t, config = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-kinds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({
      default_model: "test/model",
      max_tree_nodes: null,
      max_tree_tokens: null,
      max_concurrent_alters: null,
      retry: { same_harness_retries: 1, fallback_retries: 1 },
      ...config,
    }),
  );
  return root;
};

test("a function node costs no tokens, no home, and exactly one attempt", async (t) => {
  const root = makeProject(t);
  const { home, result } = await spawnAlter(
    root,
    createSpawnOptions({ name: "compress", prompt: "beautiful", executor: "function", capability: { id: "text.compress" } }),
    {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "btfl");
  assert.deepEqual(result.tokens, { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });
  assert.equal(result.executor, "function");
  assert.equal(result.attempts.length, 1);
  assert.ok(!existsSync(path.join(home, "AGENTS.md")));
  assert.ok(!existsSync(path.join(home, ".opencode")));
  // Still a fully readable Alter to everything downstream.
  const alter = JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
  assert.equal(alter.executor, "function");
  assert.deepEqual(alter.capability, { id: "text.compress" });
});

test("a deterministic failure is not retried, while a model failure still is", async (t) => {
  const root = makeProject(t);
  const deterministic = await spawnAlter(
    root,
    createSpawnOptions({ name: "boom", prompt: "x", executor: "function", capability: { id: "text.explode" } }),
    {},
  );
  assert.equal(deterministic.result.ok, false);
  // Same input, same answer: the configured retry and fallback tiers would burn two
  // more identical failures, and the fallback escalates to a model this never used.
  assert.equal(deterministic.result.attempts.length, 1);

  const flaky = await spawnAlter(root, createSpawnOptions({ name: "flaky", prompt: "x" }), { harness: "agent-flaky" });
  assert.equal(flaky.result.ok, false);
  assert.ok(flaky.result.attempts.length > 1, "a model failure still escalates");
});

test("a capability node runs behind the approval gate and records the same way", async (t) => {
  const root = makeProject(t);
  decision = "allow-once";
  const { result } = await spawnAlter(
    root,
    createSpawnOptions({ name: "publisher", prompt: "the report", executor: "capability", capability: { id: "host.publish" }, catalogName: "publisher" }),
    {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "published: the report");
  assert.equal(result.tokens.total, 0);
  assert.equal(result.executor, "capability");
});

test("a denied capability node fails the node without taking down the run", async (t) => {
  const root = makeProject(t);
  decision = "deny";
  const { result } = await spawnAlter(
    root,
    createSpawnOptions({ name: "publisher", prompt: "the report", executor: "capability", capability: { id: "host.publish" }, catalogName: "publisher" }),
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  decision = "allow-once";
});

test("all three kinds run in one graph and aggregate into one trace", async (t) => {
  const root = makeProject(t);
  decision = "allow-once";
  const { result } = await runAlterGraph(
    root,
    {
      id: "kinds",
      nodes: [
        { id: "planner", prompt: "decompose" },
        { id: "squeeze", depends_on: ["planner"], prompt: "{{result:planner}}", executor: "function", capability: { id: "text.compress" } },
        { id: "publish", depends_on: ["squeeze"], prompt: "{{result:squeeze}}", executor: "capability", capability: { id: "host.publish" } },
      ],
      output: "publish",
    },
    { harness: "agent-stub" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.nodes.squeeze.result.text, " plnnd dcmpstn");
  assert.equal(result.output, "published:  plnnd dcmpstn");
  // Only the reasoning node spent anything, and the aggregate says so — the two
  // model-free nodes are in the same trace at zero cost rather than absent from it.
  assert.equal(result.tokens.total, 1000);
  // The planner declares no executor, so it takes the graph's call-site harness; the
  // other two declare one, which wins over it. That split is the Phase 1 contract.
  assert.deepEqual(
    ["planner", "squeeze", "publish"].map((id) => result.nodes[id].result.executor),
    ["agent-stub", "function", "capability"],
  );
  assert.ok(existsSync(path.join(result.nodes.planner.home, "AGENTS.md")));
  assert.ok(!existsSync(path.join(result.nodes.squeeze.home, "AGENTS.md")));
});
