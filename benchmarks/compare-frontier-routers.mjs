import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime, createSpawnOptions, spawnAlter, startWorkflowOpenCodeServer, summarizeRunTree } from "../packages/core/src/index.js";
import { runLayaRouterDemo } from "../examples/laya-router/run-demo.mjs";
import { setupLayaRouter } from "../examples/laya-router/setup.mjs";
import { percentile } from "./analyze-comparison.mjs";
import { loadComparisonPlan } from "./run-comparison.mjs";
import { loadTaskSet } from "./task-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const planFile = path.join(here, "comparison-plan-frontier-v1.json");
const targetFor = (route) => route === "uppercase" ? "uppercase-tool" : route;

export const frontierRoutePrompt = ({ signal, instructions, routes }) =>
  `${instructions}\nChoose exactly one route ID for this routing signal.\n` +
  routes.map((route) => `${route.id}: ${route.description}`).join("\n") +
  `\nRouting signal: ${signal}\nReturn only the route ID.`;

const summarize = (records) => ({
  samples: records.length,
  valid_choices: records.filter((item) => item.adviser_outcome === "valid").length,
  wrong_route_rate: records.filter((item) => item.wrong_route).length / records.length,
  invalid_choice_rate: records.filter((item) => item.adviser_outcome !== "valid").length / records.length,
  payload_isolation_failures: records.filter((item) => !item.payload_isolated).length,
  median_wall_ms: percentile(records.map((item) => item.wall_ms), 0.5),
  p95_wall_ms: percentile(records.map((item) => item.wall_ms), 0.95),
  median_adviser_ms: percentile(records.map((item) => item.adviser_ms), 0.5),
  p95_adviser_ms: percentile(records.map((item) => item.adviser_ms), 0.95),
  adviser_tokens: records.reduce((sum, item) => sum + (item.adviser_tokens || 0), 0),
});

export const compareFrontierRouters = async ({
  phase = "main",
  outputDir = path.join(here, "results", `router-frontier-${new Date().toISOString().replaceAll(":", "-")}`),
  pilotReport = null,
  startServer = startWorkflowOpenCodeServer,
} = {}) => {
  if (!["pilot", "main"].includes(phase)) throw new Error("phase must be pilot or main");
  const { plan, sha256: planSha } = loadComparisonPlan(planFile);
  const { set, sha256: taskSetSha } = loadTaskSet();
  if (phase === "main") {
    if (!pilotReport) throw new Error("main router comparison requires a pilot report");
    const pilot = JSON.parse(readFileSync(pilotReport, "utf8"));
    if (pilot.phase !== "pilot" || pilot.plan_sha256 !== planSha || pilot.task_set_sha256 !== taskSetSha ||
      pilot.completed_calls !== 2 || pilot.records.some((item) => item.wrong_route || !item.payload_isolated)) {
      throw new Error("main router comparison requires a passing pilot with the same plan and task set");
    }
  }
  const validCases = set.router_cases.filter((item) => item.adviser.behavior === "valid");
  const cases = phase === "pilot" ? validCases.slice(0, 1) : validCases;
  mkdirSync(outputDir, { recursive: true });
  const records = [];
  const server = await startServer({ environment: process.env });
  try {
    for (const [modelKey, version] of Object.entries(plan.model_versions)) {
      for (const item of cases) {
        const networkRoot = path.join(outputDir, "networks", `${modelKey}-${item.id}`);
        const adviserRoot = path.join(outputDir, "advisers", `${modelKey}-${item.id}`);
        mkdirSync(networkRoot, { recursive: true });
        mkdirSync(path.join(adviserRoot, ".alters"), { recursive: true });
        setupLayaRouter(networkRoot);
        writeFileSync(path.join(adviserRoot, ".alters", "config.json"), JSON.stringify({
          default_model: version.reference,
          retry: { same_harness_retries: 0, fallback_retries: 0 },
          run_timeout_ms: 120000,
        }));
        const adviserInputs = [];
        let adviserRun = null;
        const adviser = {
          model: version.reference,
          decide: async (request) => {
            adviserInputs.push(request);
            adviserRun = await spawnAlter(adviserRoot, createSpawnOptions({
              name: "route-choice",
              description: "Choose one allowed route ID and return only that ID.",
              prompt: frontierRoutePrompt(request),
              model: version.reference,
              executor: "opencode",
              textOnly: true,
              maxTokens: 3000,
            }), { runtime: createRuntime({ env: { ...process.env, ...server.environment } }) });
            if (!adviserRun.result.ok) throw new Error("frontier adviser model failed");
            return { id: adviserRun.result.text.trim() };
          },
        };
        const run = await runLayaRouterDemo(networkRoot, {
          routingSignal: item.signal,
          payload: item.payload,
          advisers: { "laya-mlx": adviser },
        });
        const selected = run.decision.selected_route_id;
        const decisionText = readFileSync(path.join(run.home, "decision.json"), "utf8");
        const payloadIsolated = adviserInputs.length === 1 && adviserInputs[0].signal === item.signal &&
          !JSON.stringify(adviserInputs[0]).includes(item.payload) &&
          run.calls.length === Number(selected != null) &&
          (selected == null || (run.calls[0].target === targetFor(selected) && run.calls[0].payload === item.payload)) &&
          !decisionText.includes(item.payload) && !decisionText.includes(item.payload.match(/CANARY_[A-Z0-9_]+/)[0]);
        const usage = adviserRun ? summarizeRunTree(adviserRoot, adviserRun.home) : null;
        const record = {
          case_id: item.id,
          split: item.split,
          model: version.reference,
          model_key: modelKey,
          selected_route: selected,
          expected_routes: item.expected_routes,
          adviser_outcome: run.decision.adviser_outcome,
          wrong_route: selected == null || !item.expected_routes.includes(selected),
          payload_isolated: payloadIsolated,
          wall_ms: run.networkTiming.wall_duration_ms,
          adviser_ms: run.decision.decision_duration_ms,
          adviser_tokens: usage?.tokens.total ?? null,
          estimated_api_cost_usd: null,
          network_run_home: run.home,
          adviser_run_home: adviserRun?.home || null,
        };
        records.push(record);
        appendFileSync(path.join(outputDir, "records.jsonl"), JSON.stringify(record) + "\n");
      }
    }
  } finally {
    await server.stop();
  }
  const report = {
    schema_version: 1,
    phase,
    plan_sha256: planSha,
    task_set_sha256: taskSetSha,
    model_versions: plan.model_versions,
    cost_mode: "subscription",
    scheduled_calls: cases.length * Object.keys(plan.model_versions).length,
    completed_calls: records.length,
    conditions: Object.fromEntries(Object.keys(plan.model_versions).map((key) => [key, {
      all: summarize(records.filter((item) => item.model_key === key)),
      development: summarize(records.filter((item) => item.model_key === key && item.split === "development")),
      held_out: summarize(records.filter((item) => item.model_key === key && item.split === "held_out")),
    }])),
    records,
  };
  writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  return { outputDir, report };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const phase = process.argv.includes("--pilot") ? "pilot" : process.argv.includes("--main") ? "main" : null;
  const value = (flag) => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const result = await compareFrontierRouters({ phase,
    outputDir: value("--output") ? path.resolve(value("--output")) : undefined,
    pilotReport: value("--pilot-report") ? path.resolve(value("--pilot-report")) : null });
  process.stdout.write(JSON.stringify({ outputDir: result.outputDir, conditions: result.report.conditions }, null, 2) + "\n");
}
