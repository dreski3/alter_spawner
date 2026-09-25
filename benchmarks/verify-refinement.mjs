import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { percentile } from "./analyze-comparison.mjs";
import { loadComparisonPlan } from "./run-comparison.mjs";
import { loadTaskSet } from "./task-set.mjs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readRecords = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

export const verifyRefinement = ({ pilotDir, mainDir, routerFixturesFile }) => {
  const { plan, sha256: planSha } = loadComparisonPlan(path.join(mainDir, "plan.json"));
  const { set, sha256: taskSetSha } = loadTaskSet();
  const pilot = readJson(path.join(pilotDir, "report.json"));
  const main = readJson(path.join(mainDir, "report-reviewed.json"));
  const records = readRecords(path.join(mainDir, "records.jsonl"));
  const fixtures = readJson(routerFixturesFile);
  const tasks = new Map(set.tasks.map((task) => [task.id, task]));
  const sampleCount = plan.main.case_ids.length * plan.main.repetitions;
  const expectedKeys = new Set(plan.conditions.flatMap((condition) => plan.main.case_ids.flatMap((caseId) =>
    Array.from({ length: plan.main.repetitions }, (_, index) => `${condition.id}:${caseId}:${index + 1}`))));
  const observedKeys = records.map((record) => `${record.condition_id}:${record.case_id}:${record.repetition}`);
  const reviewCount = plan.main.case_ids.filter((id) => tasks.get(id)?.grading.type === "rubric").length *
    plan.main.repetitions * plan.conditions.length;
  const expectedRoute = plan.conditions.find((item) => item.id === "routed-lowest-cost");
  const expectedModel = expectedRoute?.model_candidates?.find((item) => item.id === expectedRoute.expected_candidate_id)?.model;
  const routed = records.filter((record) => record.condition_id === "routed-lowest-cost");
  const conditions = main.analysis.conditions;
  const route = conditions["routed-lowest-cost"]?.all;
  const luna = conditions["luna-attached"]?.all;
  const grok = conditions["grok-attached"]?.all;
  const pairedDelta = (conditionId) => percentile(routed.map((record) => {
    const other = records.find((item) => item.condition_id === conditionId && item.case_id === record.case_id &&
      item.repetition === record.repetition);
    return other ? record.wall_ms - other.wall_ms : null;
  }), 0.5);
  const checks = {
    fixed_inputs: pilot.plan_sha256 === planSha && main.plan_sha256 === planSha &&
      pilot.task_set_sha256 === taskSetSha && main.task_set_sha256 === taskSetSha &&
      plan.pilot.case_ids.every((id) => tasks.get(id)?.split === "development") &&
      plan.main.case_ids.every((id) => tasks.get(id)?.split === "held_out"),
    complete_matrix: pilot.completed_calls === pilot.scheduled_calls && main.completed_calls === main.scheduled_calls &&
      main.scheduled_calls === sampleCount * plan.conditions.length &&
      records.length === expectedKeys.size && new Set(observedKeys).size === expectedKeys.size &&
      observedKeys.every((key) => expectedKeys.has(key)) &&
      plan.conditions.every((condition) => conditions[condition.id]?.all.samples === sampleCount),
    review_complete: main.review?.packets === reviewCount &&
      plan.conditions.every((condition) => conditions[condition.id]?.all.blind_review_pending === 0),
    agreed_targets: route?.harness_success_rate >= plan.acceptance.min_harness_success_rate &&
      route?.auto_quality_rate >= plan.acceptance.min_auto_quality_rate &&
      route?.wrong_route_rate <= plan.acceptance.max_wrong_route_rate,
    no_quality_regression: route?.quality_rate >= luna?.quality_rate && route?.quality_rate >= grok?.quality_rate,
    observed_gain: route?.median_wall_ms < grok?.median_wall_ms,
    route_authority: routed.length === sampleCount && routed.every((record) =>
      record.status === "completed" && record.selected_candidate === expectedRoute?.expected_candidate_id &&
      record.model === expectedModel && record.attempts === 1),
    payload_isolation: fixtures.passed === true && fixtures.task_set_sha256 === taskSetSha &&
      fixtures.cases.length === set.router_cases.length && fixtures.cases.every((item) => item.passed && item.isolation),
  };
  const result = {
    schema_version: 1,
    plan_sha256: planSha,
    task_set_sha256: taskSetSha,
    accepted: Object.values(checks).every(Boolean),
    checks,
    held_out_samples_per_condition: sampleCount,
    routed_median_ms: route?.median_wall_ms ?? null,
    luna_attached_median_ms: luna?.median_wall_ms ?? null,
    grok_attached_median_ms: grok?.median_wall_ms ?? null,
    median_matched_delta_vs_luna_ms: pairedDelta("luna-attached"),
    median_matched_delta_vs_grok_ms: pairedDelta("grok-attached"),
    routed_api_equivalent_cost_usd: route?.estimated_api_cost_usd ?? null,
    grok_api_equivalent_cost_usd: grok?.estimated_api_cost_usd ?? null,
  };
  writeFileSync(path.join(mainDir, "verification.json"), JSON.stringify(result, null, 2));
  return result;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = verifyRefinement({
    pilotDir: path.resolve(process.argv[2] || ""),
    mainDir: path.resolve(process.argv[3] || ""),
    routerFixturesFile: path.resolve(process.argv[4] || ""),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.accepted) process.exitCode = 1;
}
