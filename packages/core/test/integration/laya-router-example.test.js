import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLayaRouterDemo } from "../../../../examples/laya-router/run-demo.mjs";
import { setupLayaRouter } from "../../../../examples/laya-router/setup.mjs";

const exampleDir = path.resolve("examples/laya-router");
const cli = path.resolve("packages/cli/src/index.js");

const project = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-laya-example-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = setupLayaRouter(root);
  assert.equal(network.revision, 1);
  assert.equal(network.components.length, 5);
  return root;
};

test("saved Laya network routes to one worker with unchanged payload", async (t) => {
  const root = project(t);
  const payload = "Refund the duplicate charge exactly as written.";
  const run = await runLayaRouterDemo(root, {
    routingSignal: "Customer was billed twice",
    payload,
    advisers: { "laya-mlx": { decide: async () => ({ id: "billing" }) } },
  });
  assert.equal(run.result.ok, true);
  assert.equal(run.decision.selected_route_id, "billing");
  assert.deepEqual(run.calls, [{ target: "billing", payload }]);
  assert.equal(run.result.text, `billing: ${payload}`);
  const child = JSON.parse(readFileSync(path.join(root, run.decision.child_home, "result.json"), "utf8"));
  assert.equal(child.depth, 1);
  assert.equal(readFileSync(path.join(run.home, "decision.json"), "utf8").includes(payload), false);
});

test("saved Laya network can select the deterministic tool node", async (t) => {
  const root = project(t);
  const run = await runLayaRouterDemo(root, {
    routingSignal: "Make the text uppercase",
    payload: "Hello, world!",
    advisers: { "laya-mlx": { decide: async () => ({ id: "uppercase" }) } },
  });
  assert.equal(run.result.ok, true);
  assert.deepEqual(run.calls, [{ target: "uppercase-tool", payload: "Hello, world!" }]);
  assert.equal(run.result.text, "HELLO, WORLD!");
});

test("mind network run executes the saved route with a host registry", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-laya-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, "fake-python");
  const modelDir = path.join(root, "model");
  mkdirSync(modelDir);
  writeFileSync(path.join(modelDir, "model.safetensors"), "fixture");
  writeFileSync(python, "#!/bin/sh\nprintf '{\"id\":\"billing\"}'\n");
  chmodSync(python, 0o755);
  setupLayaRouter(root, { python, modelDir });
  const payload = "Refund order 431 unchanged.";
  const result = spawnSync(process.execPath, [cli, "network", "run", "router",
    "--project", root,
    "--registry-module", path.join(exampleDir, "host.mjs"),
    "--verbose",
    "--signal", "A duplicate payment needs a refund.",
    "--payload", payload,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.route, "billing");
  assert.equal(output.child, "billing");
  assert.equal(output.result, `billing: ${payload}`);
  assert.match(result.stderr, /Network local-service-router \(revision 1\)/);
  assert.match(result.stderr, /principal \(catalog: principal; logical entry\)/);
  assert.match(result.stderr, /`-- \* router \(catalog: router; adviser: laya-mlx; spawn\)/);
  assert.match(result.stderr, /\|-- \* billing \(catalog: billing; route: billing; selected\)/);
  assert.match(result.stderr, /\|-- \. technical \(catalog: technical; route: technical\)/);
  assert.match(result.stderr, /\|-- \. sales \(catalog: sales; route: sales\)/);
  assert.match(result.stderr, /`-- \. uppercase-tool \(capability: demo.uppercase; route: uppercase\)/);
  assert.equal(result.stdout.includes("principal"), false);
  const decision = JSON.parse(readFileSync(path.join(root, output.router_home, "decision.json"), "utf8"));
  assert.equal(decision.selected_route_id, "billing");
  assert.equal(JSON.stringify(decision).includes(payload), false);
});

test("saved network and downloaded Laya model route to all four destinations", {
  skip: !process.env.MIND_LIVE_LAYA_TESTS,
}, async (t) => {
  const root = project(t);
  const cases = [
    ["billing", "The customer was billed twice and requests a refund."],
    ["technical", "The app is down and users cannot sign in due to an outage."],
    ["sales", "I want to buy a new plan and ask about pricing."],
    ["uppercase", "Convert the text to uppercase using the deterministic tool."],
  ];
  for (const [expected, routingSignal] of cases) {
    const payload = `Input stays intact for ${expected}.`;
    const run = await runLayaRouterDemo(root, { routingSignal, payload });
    assert.equal(run.result.ok, true);
    assert.equal(run.decision.selected_route_id, expected);
    assert.equal(run.decision.decision_reason, "adviser");
    assert.deepEqual(run.calls, [{ target: expected === "uppercase" ? "uppercase-tool" : expected, payload }]);
    assert.equal(run.result.text, expected === "uppercase" ? payload.toUpperCase() : `${expected}: ${payload}`);
  }
});
