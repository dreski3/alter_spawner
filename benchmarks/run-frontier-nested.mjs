import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startWorkflowOpenCodeServer } from "../packages/core/src/index.js";
import { loadComparisonPlan } from "./run-comparison.mjs";
import { runNestedWorkload } from "./run-nested.mjs";
import { loadTaskSet } from "./task-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const planFile = path.join(here, "comparison-plan-frontier-v1.json");

export const runFrontierNested = async ({
  phase,
  outputDir = path.join(here, "results", `nested-frontier-${phase}-${new Date().toISOString().replaceAll(":", "-")}`),
  pilotReport = null,
  startServer = startWorkflowOpenCodeServer,
  runWorkload = runNestedWorkload,
} = {}) => {
  if (!["pilot", "main"].includes(phase)) throw new Error("phase must be pilot or main");
  const { plan, sha256: planSha } = loadComparisonPlan(planFile);
  const { set, sha256: taskSetSha } = loadTaskSet();
  if (phase === "main") {
    if (!pilotReport) throw new Error("main nested run requires a pilot report");
    const pilot = JSON.parse(readFileSync(pilotReport, "utf8"));
    if (pilot.phase !== "pilot" || pilot.plan_sha256 !== planSha || pilot.task_set_sha256 !== taskSetSha ||
      pilot.cases.length !== 2 || pilot.cases.some((item) => !item.passed)) {
      throw new Error("main nested run requires a passing pilot with the same plan and task set");
    }
  }
  mkdirSync(outputDir, { recursive: true });
  const workloadIds = phase === "pilot" ? ["chain-1"] : ["chain-8", "branch-8"];
  const workloads = workloadIds.map((id) => set.nested_workloads.find((item) => item.id === id));
  const startedAt = new Date().toISOString();
  const cases = [];
  const server = await startServer({ environment: process.env });
  try {
    for (const [modelKey, version] of Object.entries(plan.model_versions)) {
      for (const source of workloads) {
        const item = { id: `${modelKey}-${source.id}`, shape: source.shape, max_depth: source.max_depth, split: source.split };
        const result = await runWorkload(item, {
          model: version.reference,
          keepRun: true,
          outputRoot: path.join(outputDir, "projects"),
          environment: { ...process.env, ...server.environment },
        });
        const record = { ...result, source_case_id: source.id };
        cases.push(record);
        appendFileSync(path.join(outputDir, "records.jsonl"), JSON.stringify(record) + "\n");
      }
    }
  } finally {
    await server.stop();
  }
  const report = {
    schema_version: 1,
    phase,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    plan_sha256: planSha,
    task_set_sha256: taskSetSha,
    model_versions: plan.model_versions,
    cost_mode: "subscription",
    execution: "OpenCode attached server; host-driven child spawning after each model call",
    scheduled_node_calls: phase === "pilot" ? 4 : 52,
    max_tokens_per_node: 3000,
    max_wall_ms_per_tree: 900000,
    cases,
    passed: cases.every((item) => item.passed),
  };
  writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  return { outputDir, report };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const phase = process.argv.includes("--main") ? "main" : process.argv.includes("--pilot") ? "pilot" : null;
  const value = (flag) => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const result = await runFrontierNested({ phase,
    outputDir: value("--output") ? path.resolve(value("--output")) : undefined,
    pilotReport: value("--pilot-report") ? path.resolve(value("--pilot-report")) : null });
  process.stdout.write(JSON.stringify({ outputDir: result.outputDir, passed: result.report.passed,
    cases: result.report.cases.map((item) => ({ case_id: item.case_id, passed: item.passed,
      nodes: item.tree_usage.runs, exact_answer_nodes: item.exact_answer_nodes })) }, null, 2) + "\n");
  if (!result.report.passed) process.exitCode = 1;
}
