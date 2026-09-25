import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { comparisonSchedule, loadComparisonPlan, runPairedComparison } from "../../../../benchmarks/run-comparison.mjs";

const tokens = { input: 2, output: 1, reasoning: 0, cache_read: 0, total: 3 };

test("comparison schedule is paired, seeded, and bounded before any call", () => {
  const { plan } = loadComparisonPlan();
  const first = comparisonSchedule(plan, "pilot");
  assert.deepEqual(first, comparisonSchedule(plan, "pilot"));
  assert.equal(first.length, 8);
  for (const id of plan.pilot.case_ids) {
    assert.deepEqual(new Set(first.filter((item) => item.case_id === id).map((item) => item.condition_id)),
      new Set(plan.conditions.map((item) => item.id)));
  }
});

test("comparison report preserves raw references, scoring, and condition blinding", async (t) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "mind-comparison-test-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const planInfo = loadComparisonPlan();
  const started = [];
  let stopped = false;
  const run = await runPairedComparison({
    phase: "pilot",
    planInfo,
    outputDir,
    resolveCredential: () => "fixture-key",
    startServer: async () => ({ environment: { OPENCODE_SERVER_URL: "http://127.0.0.1:1" }, stop: async () => { stopped = true; } }),
    invoke: async (root, options) => {
      started.push(options);
      const home = path.join(root, ".alters", "runs", options.name);
      mkdirSync(home, { recursive: true });
      const result = {
        ok: true,
        text: options.name.startsWith("class-") ? "positive" : '{"invoice_id":"INV-2047","amount_eur":38.5}',
        timing: { wall_duration_ms: 12 },
        depth: 0,
        tree_id: `tree-${options.name}`,
        attempts: [{ model: options.model, executor: options.executor, tokens, pricing: {
          cost: { input_per_million: 0, output_per_million: 0, cache_read_per_million: null },
        } }],
      };
      writeFileSync(path.join(home, "result.json"), JSON.stringify(result));
      return { home, result };
    },
  });
  assert.equal(started.length, 8);
  assert.equal(stopped, true);
  assert.equal(run.report.completed_calls, 8);
  assert.equal(run.records.every((record) => record.status === "completed" && record.estimated_api_cost_usd != null), true);
  assert.equal(run.report.analysis.conditions["cloud-direct"].all.samples, 2);
  assert.equal(run.report.analysis.pairs.length, 3);
  assert.equal(readFileSync(path.join(outputDir, "records.jsonl"), "utf8").trim().split("\n").length, 8);
  assert.equal(readFileSync(path.join(outputDir, "blind-packets.json"), "utf8"), "[]");
});

test("comparison cap rejects a priced matrix before starting the server", async (t) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "mind-comparison-cap-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const original = loadComparisonPlan();
  const plan = structuredClone(original.plan);
  plan.providers.mistral.models["ministral-8b-latest"].cost.input_per_million = 1;
  let started = false;
  await assert.rejects(() => runPairedComparison({
    phase: "pilot", planInfo: { ...original, plan }, outputDir,
    startServer: async () => { started = true; },
  }), /estimated cost cap/);
  assert.equal(started, false);
});

test("subscription comparison preserves unknown cost and finishes its fixed call budget", async (t) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "mind-subscription-comparison-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const planInfo = loadComparisonPlan(new URL("../../../../benchmarks/comparison-plan-frontier-v1.json", import.meta.url));
  const run = await runPairedComparison({
    phase: "pilot", planInfo, outputDir,
    startServer: async () => ({ environment: { OPENCODE_SERVER_URL: "http://127.0.0.1:1" }, stop: async () => {} }),
    invoke: async (root, options) => {
      const home = path.join(root, ".alters", "runs", options.name);
      mkdirSync(home, { recursive: true });
      const result = {
        ok: true, text: "positive", timing: { wall_duration_ms: 12 }, depth: 0, tree_id: `tree-${options.name}`,
        attempts: [{ model: options.model, executor: options.executor, tokens, pricing: { cost: null } }],
      };
      writeFileSync(path.join(home, "result.json"), JSON.stringify(result));
      return { home, result };
    },
  });
  assert.equal(run.report.completed_calls, 8);
  assert.equal(run.report.stopped_for_cost, false);
  assert.equal(run.report.cost_mode, "subscription");
  assert.equal(run.report.observed_priced_cost_usd, null);
  assert.equal(run.report.analysis.conditions["luna-attached"].all.estimated_api_cost_usd, null);
  assert.equal(run.report.analysis.pairs.length, 2);
});

test("image comparison records the enlarged fixture and its hash", async (t) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "mind-image-comparison-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const planInfo = loadComparisonPlan(new URL("../../../../benchmarks/comparison-plan-frontier-image-v2.json", import.meta.url));
  const images = [];
  const run = await runPairedComparison({
    phase: "pilot", planInfo, outputDir,
    startServer: async () => ({ environment: { OPENCODE_SERVER_URL: "http://127.0.0.1:1" }, stop: async () => {} }),
    invoke: async (root, options) => {
      images.push(options.images[0]);
      const home = path.join(root, ".alters", "runs", options.name);
      mkdirSync(home, { recursive: true });
      const result = { ok: true, text: "red", timing: { wall_duration_ms: 12 }, depth: 0, tree_id: `tree-${options.name}`,
        attempts: [{ model: options.model, executor: options.executor, tokens, pricing: { cost: null } }] };
      writeFileSync(path.join(home, "result.json"), JSON.stringify(result));
      return { home, result };
    },
  });
  assert.equal(run.report.completed_calls, 4);
  assert.equal(images.every((image) => image.endsWith("/red-square-64.png")), true);
  assert.match(run.report.image_fixture_sha256["fixtures/red-square-64.png"], /^[a-f0-9]{64}$/);
  assert.equal(run.report.analysis.conditions["grok-fresh"].all.auto_quality_rate, 1);
});
