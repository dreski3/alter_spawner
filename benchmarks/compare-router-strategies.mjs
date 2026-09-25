import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLayaMlxAdviser } from "../packages/core/src/index.js";
import { runLayaRouterDemo } from "../examples/laya-router/run-demo.mjs";
import { setupLayaRouter } from "../examples/laya-router/setup.mjs";
import { loadTaskSet } from "./task-set.mjs";
import { runRouterCases } from "./run-router-cases.mjs";
import { percentile } from "./analyze-comparison.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetFor = (route) => route === "uppercase" ? "uppercase-tool" : route;

export const classifySignal = (signal) => {
  const text = signal.toLowerCase();
  if (/uppercase|upper case/.test(text)) return "uppercase";
  if (/sign.in|login|account|open billing page/.test(text)) return "technical";
  if (/invoice|charge|refund|billed/.test(text)) return "billing";
  if (/plan|pricing|purchase|seats/.test(text)) return "sales";
  return null;
};

const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

const summarize = (records) => ({
  samples: records.length,
  valid_choices: records.filter((record) => record.adviser_outcome === "valid").length,
  wrong_route_rate: records.length ? records.filter((record) => record.wrong_route).length / records.length : null,
  invalid_choice_rate: records.length ? records.filter((record) => record.adviser_outcome !== "valid").length / records.length : null,
  payload_isolation_failures: records.filter((record) => !record.payload_isolated).length,
  median_wall_ms: percentile(records.map((record) => record.wall_ms), 0.5),
  p95_wall_ms: percentile(records.map((record) => record.wall_ms), 0.95),
  median_adviser_ms: percentile(records.map((record) => record.adviser_ms), 0.5),
  p95_adviser_ms: percentile(records.map((record) => record.adviser_ms), 0.95),
});

export const compareRouterStrategies = async ({
  cases = loadTaskSet().set.router_cases.filter((item) => item.adviser.behavior === "valid"),
  python = process.env.LAYA_MLX_PYTHON,
  modelDir = process.env.LAYA_MLX_MODEL_DIR,
  outputDir = path.join(here, "results", `router-${new Date().toISOString().replaceAll(":", "-")}`),
} = {}) => {
  if (!python || !modelDir) throw new Error("set LAYA_MLX_PYTHON and LAYA_MLX_MODEL_DIR");
  mkdirSync(outputDir, { recursive: true });
  const records = [];
  const local = createLayaMlxAdviser({ python, model_dir: modelDir, timeout_ms: 60000 });
  for (const item of cases) {
    for (const strategy of ["classifier", "laya-mlx"]) {
      const root = path.join(outputDir, "projects", `${item.id}-${strategy}`);
      if (existsSync(root)) throw new Error(`router output already exists: ${root}`);
      mkdirSync(root, { recursive: true });
      setupLayaRouter(root);
      const adviserInputs = [];
      const adviser = strategy === "classifier"
        ? { decide: async (request) => ({ id: classifySignal(request.signal) }) }
        : local;
      const wrapped = { decide: async (request) => {
        adviserInputs.push(request);
        return adviser.decide(request);
      } };
      const run = await runLayaRouterDemo(root, {
        routingSignal: item.signal,
        payload: item.payload,
        advisers: { "laya-mlx": wrapped },
      });
      const selected = run.decision.selected_route_id;
      const decisionText = readFileSync(path.join(run.home, "decision.json"), "utf8");
      const isolated = adviserInputs.length === 1 && adviserInputs[0].signal === item.signal &&
        !JSON.stringify(adviserInputs[0]).includes(item.payload) &&
        run.calls.length === Number(selected != null) &&
        (selected == null || (run.calls[0].target === targetFor(selected) && run.calls[0].payload === item.payload)) &&
        !decisionText.includes(item.payload) && !decisionText.includes(item.payload.match(/CANARY_[A-Z0-9_]+/)[0]);
      records.push({
        case_id: item.id,
        split: item.split,
        strategy,
        selected_route: selected,
        adviser_outcome: run.decision.adviser_outcome,
        wrong_route: selected == null || !item.expected_routes.includes(selected),
        payload_isolated: isolated,
        run_home: run.home,
        wall_ms: run.networkTiming.wall_duration_ms,
        adviser_ms: run.decision.decision_duration_ms ?? null,
        estimated_api_cost_usd: 0,
      });
    }
  }
  const failureCases = loadTaskSet().set.router_cases.filter((item) => item.adviser.behavior !== "valid");
  const fallback = await runRouterCases({ cases: failureCases, keepRuns: true,
    outputRoot: path.join(outputDir, "fallback-projects") });
  const report = {
    schema_version: 1,
    task_set_sha256: loadTaskSet().sha256,
    checkpoint_sha256: await digest(path.join(modelDir, "model.safetensors")),
    strategies: Object.fromEntries(["classifier", "laya-mlx"].map((strategy) => [strategy, {
      all: summarize(records.filter((record) => record.strategy === strategy)),
      development: summarize(records.filter((record) => record.strategy === strategy && record.split === "development")),
      held_out: summarize(records.filter((record) => record.strategy === strategy && record.split === "held_out")),
    }])),
    fallback: { samples: fallback.cases.length, passed: fallback.cases.filter((record) => record.passed).length,
      wrong_route_rate: fallback.cases.filter((record) => record.wrong_route).length / fallback.cases.length,
      payload_isolation_failures: fallback.cases.filter((record) => !record.isolation).length,
      records: fallback.cases },
    records,
  };
  writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  return { outputDir, report };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const index = process.argv.indexOf("--output");
  const outputDir = index < 0 ? undefined : path.resolve(process.argv[index + 1]);
  const result = await compareRouterStrategies({ outputDir });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
