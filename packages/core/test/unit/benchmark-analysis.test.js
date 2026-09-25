import test from "node:test";
import assert from "node:assert/strict";
import { analyzeComparison, percentile, summarizeCondition } from "../../../../benchmarks/analyze-comparison.mjs";
import { classifySignal } from "../../../../benchmarks/compare-router-strategies.mjs";
import { frontierRoutePrompt } from "../../../../benchmarks/compare-frontier-routers.mjs";

test("percentiles and unknown cost retain their sample counts", () => {
  assert.equal(percentile([3, 1, 2, 4], 0.5), 2.5);
  assert.equal(percentile([3, 1, 2, 4], 0.95), 4);
  assert.equal(percentile([null], 0.5), null);
  const summary = summarizeCondition([
    { status: "completed", wall_ms: 10, harness_ok: true, quality_score: 1, estimated_api_cost_usd: 0 },
    { status: "completed", wall_ms: 20, harness_ok: true, quality_score: 0, estimated_api_cost_usd: null },
  ]);
  assert.equal(summary.median_wall_ms, 15);
  assert.equal(summary.auto_quality_rate, 0.5);
  assert.equal(summary.estimated_api_cost_usd, null);
  assert.equal(summary.priced_samples, 1);
  assert.equal(summary.wrong_route_rate, null);
});

test("paired deltas match the same task and repetition on one model", () => {
  const conditions = [
    { id: "direct", executor: "llm", model: "cloud/model", pair_group: "cloud" },
    { id: "attached", executor: "opencode", model: "cloud/model", pair_group: "cloud" },
    { id: "local", executor: "llm", model: "local/model", pair_group: "local" },
  ];
  const records = [
    { case_id: "a", repetition: 1, condition_id: "direct", status: "completed", wall_ms: 10, estimated_api_cost_usd: 0.1, quality_score: 1 },
    { case_id: "a", repetition: 1, condition_id: "attached", status: "completed", wall_ms: 15, estimated_api_cost_usd: 0.2, quality_score: 1 },
    { case_id: "a", repetition: 1, condition_id: "local", status: "completed", wall_ms: 2, estimated_api_cost_usd: 0, quality_score: 0 },
  ];
  const report = analyzeComparison(records, conditions);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].samples, 1);
  assert.equal(report.pairs[0].median_wall_delta_ms, 5);
  assert.equal(report.pairs[0].median_cost_delta_usd, 0.1);
  assert.equal(report.pairs[0].auto_quality_delta, 0);
});

test("reviewed quality and failed calls keep separate counts", () => {
  const summary = summarizeCondition([
    { status: "completed", harness_ok: true, quality_score: 1, needs_blinded_review: false },
    { status: "completed", harness_ok: true, quality_score: 0.75, needs_blinded_review: true },
    { status: "error" },
  ]);
  assert.equal(summary.harness_success_rate, 2 / 3);
  assert.equal(summary.quality_rate, 0.875);
  assert.equal(summary.auto_quality_rate, 1);
  assert.equal(summary.reviewed_samples, 1);
  assert.equal(summary.blind_review_pending, 0);
});

test("fixed classifier routes a billing signal and leaves unmatched signals unset", () => {
  assert.equal(classifySignal("Refund a duplicate charge"), "billing");
  assert.equal(classifySignal("A harmless summary"), null);
});

test("frontier route prompt contains only signal and allowed route descriptions", () => {
  const prompt = frontierRoutePrompt({ signal: "Need a refund", instructions: "Choose a destination",
    routes: [{ id: "billing", description: "Invoices and refunds" }, { id: "sales", description: "New plans" }] });
  assert.match(prompt, /Need a refund/);
  assert.match(prompt, /billing: Invoices and refunds/);
  assert.equal(prompt.includes("CANARY_SECRET_PAYLOAD"), false);
});
