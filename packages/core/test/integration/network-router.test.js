import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyNetworkDefinition,
  createCapabilityRegistry,
  createRuntime,
  registerHarness,
  runNetworkRoute,
} from "@mind/core";

const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-router-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters", "catalog"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "test/model",
    max_depth: 3,
    max_tree_nodes: 2,
    max_concurrent_alters: 1,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  for (const name of ["router", "billing", "sales"]) {
    const dir = path.join(root, ".alters", "catalog", name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      name,
      description: name,
      ...(name === "router" ? {} : { executor: "router-worker-test", model: "test/model" }),
      ...(name === "billing" ? { prompt_prefix: "Catalog prefix", prompt_suffix: "Catalog suffix" } : {}),
    }));
  }
  const network = {
    id: "dispatch",
    name: "Dispatch",
    ego: { enabled: true, catalog: "router", spawn: ["router"] },
    interfaces: [{ id: "service", name: "Service", actions: ["tool.echo"] }],
    components: [
      {
        id: "router", role: "internal", catalog: "router", triggers: [{ type: "manual" }],
        router: {
          instructions: "Choose a destination for the principal's category.",
          routes: [
            { id: "billing", component: "billing", description: "Bills and refunds" },
            { id: "sales", component: "sales", description: "Plans and purchases" },
            { id: "tool", component: "echo", description: "Run the echo tool" },
          ],
        },
      },
      { id: "billing", role: "internal", catalog: "billing", triggers: [{ type: "manual" }] },
      { id: "sales", role: "internal", catalog: "sales", triggers: [{ type: "manual" }] },
      { id: "echo", role: "active", capability: "tool.echo", triggers: [{ type: "manual" }] },
    ],
  };
  const registry = createCapabilityRegistry({ definitions: [{
    id: "tool.echo",
    name: "Echo",
    description: "Return the text unchanged",
    approval: "never",
    inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } },
    handler: ({ input }) => input.text,
  }] });
  applyNetworkDefinition(root, network, { known: { catalogs: ["router", "billing", "sales"], capabilities: ["tool.echo"] } });
  return { root, network, registry };
};

const workerCalls = [];
registerHarness("router-worker-test", {
  needsAgentHome: false,
  supportsRetry: false,
  async run(_home, prompt, options) {
    workerCalls.push({ prompt, depth: options.depth, alterId: options.alterId });
    return {
      ok: true, text: `handled:${prompt}`, tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
      steps: 1, exitCode: 0, killed: false, budget_exceeded: false, empty_output: false, sessionID: null,
    };
  },
});

test("router Alter selects one worker and forwards the payload unchanged", async (t) => {
  workerCalls.length = 0;
  const { root, registry } = fixture(t);
  const payload = "Original request: refund $25.\nKeep punctuation intact.";
  let adviserInput;
  const result = await runNetworkRoute(root, {
    routerId: "router",
    routingSignal: "billing",
    payload,
    capabilityRegistry: registry,
    advisers: { "laya-mlx": { decide: async (input) => {
      adviserInput = input;
      return { id: "billing" };
    } } },
    runtime: createRuntime({ env: { ...process.env } }),
  });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.text, `handled:${payload}`);
  assert.equal(workerCalls.length, 1);
  assert.deepEqual(workerCalls[0], { prompt: payload, depth: 1, alterId: "billing" });
  assert.equal(adviserInput.signal, "billing");
  assert.equal(JSON.stringify(adviserInput).includes(payload), false);
  assert.equal(result.decision.selected_route_id, "billing");
  assert.equal(result.decision.child_ok, true);
  assert.ok(result.decision.child_wall_duration_ms >= 0);
  assert.equal(result.decision.network_revision, 1);
  assert.equal(result.decision.adviser_outcome, "valid");
  assert.ok(result.decision.decision_duration_ms >= 0);
  assert.ok(result.networkTiming.wall_duration_ms >= result.decision.decision_duration_ms);
  assert.equal(result.treeUsage.runs, 2);
  assert.equal(result.treeUsage.attempts, 2);
  assert.equal(result.treeUsage.max_depth, 1);
  assert.equal(readFileSync(path.join(result.home, "decision.json"), "utf8").includes(payload), false);
  const ledger = JSON.parse(readFileSync(path.join(root, ".alters", "trees", readdirSync(path.join(root, ".alters", "trees"))[0]), "utf8"));
  assert.equal(ledger.nodes_admitted, 2);
});

test("router can select a deterministic capability node", async (t) => {
  workerCalls.length = 0;
  const { root, registry } = fixture(t);
  const result = await runNetworkRoute(root, {
    routerId: "router", routingSignal: "tool", payload: "Run this exactly",
    capabilityRegistry: registry,
    advisers: { "laya-mlx": { decide: async () => ({ id: "tool" }) } },
  });
  assert.equal(result.result.ok, true);
  assert.equal(result.result.text, "Run this exactly");
  assert.equal(result.decision.child_component_id, "echo");
  assert.equal(workerCalls.length, 0);
});

test("invalid adviser choice fails closed unless an explicit fallback exists", async (t) => {
  workerCalls.length = 0;
  const { root, network, registry } = fixture(t);
  const input = {
    routerId: "router", routingSignal: "unknown", payload: "secret payload",
    capabilityRegistry: registry,
    advisers: { "laya-mlx": { decide: async () => ({ id: "forbidden" }) } },
  };
  const denied = await runNetworkRoute(root, input);
  assert.equal(denied.result.ok, false);
  assert.equal(denied.decision.selected_route_id, null);
  assert.equal(denied.decision.adviser_outcome, "invalid");
  assert.ok(denied.decision.decision_duration_ms >= 0);
  assert.equal(workerCalls.length, 0);
  applyNetworkDefinition(root, {
    ...network,
    components: network.components.map((component) => component.id === "router"
      ? { ...component, router: { ...component.router, fallback_route: "sales" } }
      : component),
  }, { expectedRevision: 1 });
  const fallback = await runNetworkRoute(root, input);
  assert.equal(fallback.result.ok, true);
  assert.equal(fallback.decision.selected_route_id, "sales");
  assert.equal(fallback.decision.decision_reason, "fallback");
  assert.equal(fallback.decision.adviser_outcome, "invalid");
});

test("adviser timeout is timed even when no worker is spawned", async (t) => {
  workerCalls.length = 0;
  const { root, registry } = fixture(t);
  const run = await runNetworkRoute(root, {
    routerId: "router",
    routingSignal: "billing",
    payload: "Keep this private",
    capabilityRegistry: registry,
    advisers: { "laya-mlx": { decide: async () => { throw new Error("decision timed out"); } } },
  });
  assert.equal(run.result.ok, false);
  assert.equal(run.decision.adviser_outcome, "timeout");
  assert.ok(run.decision.decision_duration_ms >= 0);
  assert.equal(run.treeUsage.runs, 1);
  assert.equal(workerCalls.length, 0);
});

test("local laya-mlx selects and spawns a worker in a two-level run", {
  skip: !process.env.MIND_LIVE_LAYA_TESTS,
}, async (t) => {
  workerCalls.length = 0;
  const { root, registry } = fixture(t);
  const payload = "Keep this request unchanged";
  const result = await runNetworkRoute(root, {
    routerId: "router",
    routingSignal: "The customer was billed twice and requests a refund.",
    payload,
    capabilityRegistry: registry,
  });
  assert.equal(result.result.ok, true);
  assert.equal(result.decision.selected_route_id, "billing");
  assert.equal(result.decision.decision_reason, "adviser");
  assert.equal(workerCalls[0].prompt, payload);
  assert.equal(workerCalls[0].depth, 1);
});
