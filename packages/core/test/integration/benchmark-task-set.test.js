import test from "node:test";
import assert from "node:assert/strict";
import { blindReviewPacket, fixturePath, loadTaskSet, scoreBlindReview, scoreTask, validateTaskSet } from "../../../../benchmarks/task-set.mjs";
import { runRouterCases } from "../../../../benchmarks/run-router-cases.mjs";
import { runNestedMatrix } from "../../../../benchmarks/run-nested.mjs";
import { validateImageFiles } from "../../src/index.js";

test("benchmark labels cover task, router, and deep nested matrices", () => {
  const { set, sha256 } = loadTaskSet();
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.equal(set.tasks.length, 10);
  assert.equal(set.router_cases.length, 13);
  assert.equal(set.nested_workloads.length, 8);
  for (const task of set.tasks.filter((entry) => entry.kind === "image")) {
    assert.equal(validateImageFiles("/", [fixturePath(task.image)])[0].metadata.media_type, "image/png");
  }
  const leaked = structuredClone(set);
  leaked.router_cases[0].signal = leaked.router_cases[0].payload;
  assert.throws(() => validateTaskSet(leaked), /canary missing/);
});

test("quality scoring remains separate from harness success and blind review omits executor identity", () => {
  const { set } = loadTaskSet();
  const exact = set.tasks.find((task) => task.id === "class-positive");
  assert.deepEqual(scoreTask(exact, { ok: true, text: "negative" }), {
    case_id: exact.id, harness_ok: true, quality_score: 0, needs_blinded_review: false,
  });
  const extraction = set.tasks.find((task) => task.id === "extract-invoice");
  assert.equal(scoreTask(extraction, { ok: true, text: '{"invoice_id":"INV-2047","amount_eur":38.5}' }).quality_score, 1);
  assert.equal(scoreTask(extraction, { ok: true, text: "not json" }).quality_score, 0);
  const tool = set.tasks.find((task) => task.id === "tool-uppercase");
  assert.equal(scoreTask(tool, { ok: true, text: "READY NOW", tools: { byName: {} } }).quality_score, 0);
  assert.equal(scoreTask(tool, { ok: true, text: "READY NOW", tools: { byName: { "demo.uppercase": 1 } } }).quality_score, 1);
  const rubric = set.tasks.find((task) => task.grading.type === "rubric");
  const observation = { ok: true, text: "Contain the privacy incident first.", executor: "cloud-secret-model" };
  assert.equal(scoreTask(rubric, observation).quality_score, null);
  assert.equal(JSON.stringify(blindReviewPacket(rubric, observation)).includes(observation.executor), false);
  assert.equal(scoreBlindReview(rubric, [1, 1, 0, 1]), 0.75);
  assert.throws(() => scoreBlindReview(rubric, [1, 1]), /one 0 or 1/);
});

test("router fixtures enforce signal-only decisions and chosen-worker payload delivery", async () => {
  const report = await runRouterCases();
  assert.equal(report.passed, true);
  assert.equal(report.cases.length, 13);
  assert.ok(report.cases.every((item) => item.isolation));
  assert.ok(report.cases.every((item) => !item.wrong_route));
  assert.equal(report.cases.find((item) => item.case_id === "route-invalid-closed").selected_route, null);
});

test("nested matrix records per-depth queue, retries, spend, and failures through depth eight", async () => {
  const report = await runNestedMatrix();
  assert.equal(report.passed, true);
  assert.equal(report.cases.length, 8);
  const deep = report.cases.find((item) => item.case_id === "branch-8");
  assert.equal(deep.tree_usage.runs, 17);
  assert.equal(deep.tree_usage.max_depth, 8);
  assert.equal(deep.per_depth.length, 9);
  assert.equal(deep.per_depth.reduce((sum, item) => sum + item.retries, 0), 1);
  assert.equal(deep.per_depth.reduce((sum, item) => sum + item.failed_nodes, 0), 1);
  assert.ok(deep.per_depth.some((item) => item.queue_ms > 0));
  assert.equal(deep.per_depth.reduce((sum, item) => sum + item.tokens, 0), deep.tree_usage.tokens.total);
});
