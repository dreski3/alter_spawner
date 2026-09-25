import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLayaMlxAdviser, decideRoute, planRequest } from "../packages/core/src/index.js";
import { analyzeComparison } from "./analyze-comparison.mjs";
import { loadComparisonPlan } from "./run-comparison.mjs";
import { loadTaskSet, scoreBlindReview } from "./task-set.mjs";

const adviserPolicy = {
  id: "laya-mlx",
  instructions: "Choose the model route for the request. Local is free and suitable for simple text tasks. Cloud may be more reliable for complex reasoning. Return one route ID.",
  criteria: {
    cloud: "Remote paid text model for complex reasoning or difficult output requirements",
    local: "Local free text model for simple classification and extraction",
  },
};

export const compareCandidatePolicies = async ({
  mainDir,
  python = process.env.LAYA_MLX_PYTHON,
  modelDir = process.env.LAYA_MLX_MODEL_DIR,
} = {}) => {
  if (!mainDir || !python || !modelDir) throw new Error("provide mainDir, LAYA_MLX_PYTHON and LAYA_MLX_MODEL_DIR");
  const { plan, sha256: planSha } = loadComparisonPlan();
  const report = JSON.parse(readFileSync(path.join(mainDir, "report.json"), "utf8"));
  if (report.phase !== "main" || report.plan_sha256 !== planSha || report.completed_calls !== report.scheduled_calls) {
    throw new Error("candidate comparison requires a complete matching main run");
  }
  const observations = readFileSync(path.join(mainDir, "records.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const blindMap = JSON.parse(readFileSync(path.join(mainDir, "blind-map.json"), "utf8"));
  const ratings = JSON.parse(readFileSync(path.join(mainDir, "blind-ratings.json"), "utf8"));
  for (const [reviewId, identity] of Object.entries(blindMap)) {
    const observation = observations.find((item) => item.case_id === identity.case_id &&
      item.repetition === identity.repetition && item.condition_id === identity.condition_id);
    const task = loadTaskSet().set.tasks.find((item) => item.id === identity.case_id);
    if (!observation || !ratings[reviewId]) throw new Error(`missing blind review ${reviewId}`);
    observation.quality_score = scoreBlindReview(task, ratings[reviewId]);
  }
  const tasks = loadTaskSet().set.tasks.filter((task) => plan.main.case_ids.includes(task.id));
  const adviser = createLayaMlxAdviser({ python, model_dir: modelDir, timeout_ms: 60000 });
  const records = [];
  const environment = { ...process.env, BENCH_MISTRAL_API_KEY: "routing-only-placeholder" };
  for (const task of tasks) {
    for (const strategy of ["ordered", "lowest_cost", "adviser"]) {
      const start = performance.now();
      const routing = strategy === "adviser" ? { adviser: adviserPolicy } : { strategy };
      const planned = planRequest({
        options: {
          modelCandidates: [
            { id: "cloud", model: "mistral/ministral-8b-latest", executor: "llm" },
            { id: "local", model: "ollama/gemma4:e2b", executor: "llm" },
          ],
          routing,
          maxTokens: 256,
          textOnly: true,
        },
        config: { providers: plan.providers },
        prompt: task.prompt,
        environment,
      });
      let chosen = planned.candidates[0].id;
      let adviserOutcome = null;
      if (strategy === "adviser") {
        const decision = await decideRoute({
          adviser,
          signal: task.prompt,
          instructions: adviserPolicy.instructions,
          routes: planned.candidates.map((candidate) => ({ id: candidate.id, description: adviserPolicy.criteria[candidate.id] })),
          fallbackRoute: "cloud",
        });
        chosen = decision.id;
        adviserOutcome = decision.adviserOutcome;
      }
      const routingMs = performance.now() - start;
      const conditionId = chosen === "cloud" ? "cloud-direct" : "local-direct";
      for (let repetition = 1; repetition <= plan.main.repetitions; repetition++) {
        const observation = observations.find((item) => item.case_id === task.id && item.repetition === repetition && item.condition_id === conditionId);
        if (!observation) throw new Error(`missing observation for ${task.id}/${repetition}/${conditionId}`);
        records.push({ ...observation, condition_id: strategy, selected_candidate: chosen,
          temperature: repetition === 1 ? "cold" : "warm", routing_ms: routingMs,
          wall_ms: observation.wall_ms + routingMs, adviser_outcome: adviserOutcome,
          invalid_choice: adviserOutcome == null ? null : adviserOutcome !== "valid" });
      }
    }
  }
  const conditions = ["ordered", "lowest_cost", "adviser"].map((id) => ({ id, executor: "policy", model: "paired-direct-observations" }));
  const output = {
    schema_version: 1,
    source_main_report: path.join(mainDir, "report.json"),
    task_set_sha256: report.task_set_sha256,
    plan_sha256: planSha,
    note: "Policy replay uses the observed direct outputs and blind ratings for each selected model and repetition; one measured route latency per task is added to each repetition. It does not execute a separate model request per policy.",
    policies: analyzeComparison(records, conditions).conditions,
    route_counts: Object.fromEntries(conditions.map(({ id }) => [id, {
      cloud: records.filter((record) => record.condition_id === id && record.selected_candidate === "cloud").length,
      local: records.filter((record) => record.condition_id === id && record.selected_candidate === "local").length,
    }])),
    records,
  };
  writeFileSync(path.join(mainDir, "candidate-policies.json"), JSON.stringify(output, null, 2));
  return output;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const output = await compareCandidatePolicies({ mainDir: path.resolve(process.argv[2] || "") });
  process.stdout.write(JSON.stringify({ policies: output.policies, route_counts: output.route_counts }, null, 2) + "\n");
}
