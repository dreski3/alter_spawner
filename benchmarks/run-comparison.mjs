import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authFilePath, createRuntime, createSpawnOptions, loadAuth, spawnAlter, startWorkflowOpenCodeServer, summarizeRunTree } from "../packages/core/src/index.js";
import { analyzeComparison } from "./analyze-comparison.mjs";
import { blindReviewPacket, loadTaskSet, scoreTask } from "./task-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPlan = path.join(here, "comparison-plan-v1.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const loadComparisonPlan = (file = defaultPlan) => {
  const bytes = readFileSync(file);
  const plan = JSON.parse(bytes);
  if (plan?.schema_version !== 1 || !Array.isArray(plan.conditions) || plan.conditions.length < 2 ||
    !Number.isInteger(plan.seed) || !plan.pilot || !plan.main) throw new Error("invalid comparison plan");
  if (plan.cost_mode != null && !["api", "subscription"].includes(plan.cost_mode)) throw new Error("invalid cost mode");
  if (plan.image_fixture_overrides != null && (typeof plan.image_fixture_overrides !== "object" ||
    Array.isArray(plan.image_fixture_overrides) || Object.values(plan.image_fixture_overrides).some((value) =>
      typeof value !== "string" || !/^fixtures\/[a-z0-9-]+\.png$/.test(value)))) {
    throw new Error("invalid image fixture overrides");
  }
  for (const phase of ["pilot", "main"]) {
    const spec = plan[phase];
    if (!Array.isArray(spec.case_ids) || !Number.isInteger(spec.repetitions) || spec.repetitions < 1 ||
      !Number.isInteger(spec.max_calls) || spec.max_calls < 1 ||
      (plan.cost_mode === "subscription" ? spec.max_estimated_cost_usd !== null
        : !Number.isFinite(spec.max_estimated_cost_usd) || spec.max_estimated_cost_usd < 0) ||
      !Number.isFinite(spec.max_wall_ms) || spec.max_wall_ms <= 0) throw new Error(`invalid ${phase} limits`);
  }
  return { plan, sha256: hash(bytes), file };
};

const random = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

export const comparisonSchedule = (plan, phase) => {
  const spec = plan[phase];
  const next = random(plan.seed + (phase === "main" ? 1 : 0));
  const schedule = [];
  for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
    const cases = [...spec.case_ids];
    for (let i = cases.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [cases[i], cases[j]] = [cases[j], cases[i]];
    }
    for (const caseId of cases) {
      const conditions = plan.conditions.map((condition) => condition.id);
      for (let i = conditions.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [conditions[i], conditions[j]] = [conditions[j], conditions[i]];
      }
      for (const conditionId of conditions) schedule.push({ case_id: caseId, condition_id: conditionId, repetition });
    }
  }
  return schedule;
};

const maxCallCost = (plan, condition) => {
  if (plan.cost_mode === "subscription") return null;
  const [providerId, modelId] = condition.model.split(/\/(.+)/);
  const provider = plan.providers?.[providerId];
  const cost = provider?.models?.[modelId]?.cost ?? provider?.cost;
  if (!cost || !Number.isFinite(cost.input_per_million) || !Number.isFinite(cost.output_per_million)) {
    throw new Error(`missing price assumption for ${condition.model}`);
  }
  return (plan.run.max_input_tokens_for_cap * cost.input_per_million +
    plan.run.max_output_tokens_for_cap * cost.output_per_million) / 1_000_000;
};

export const exclusionsFor = (set, phase, included) => set.tasks.filter((task) => !included.has(task.id)).map((task) => ({
  case_id: task.id,
  reason: phase === "pilot" ? "pilot_subset" : task.kind === "tool"
    ? "shared_tool_not_bound_in_comparison" : "outside_main_matrix",
}));

export const runPairedComparison = async ({
  phase,
  planInfo = loadComparisonPlan(),
  outputDir = path.join(here, "results", `${phase}-${new Date().toISOString().replaceAll(":", "-")}`),
  pilotReport = null,
  invoke = spawnAlter,
  startServer = startWorkflowOpenCodeServer,
  resolveCredential = (provider) => loadAuth(authFilePath())?.[provider]?.key || null,
} = {}) => {
  if (!["pilot", "main"].includes(phase)) throw new Error("phase must be pilot or main");
  const { set, sha256: taskSetSha } = loadTaskSet();
  const { plan, sha256: planSha } = planInfo;
  if (phase === "main") {
    if (!pilotReport) throw new Error("main run requires a pilot report");
    const pilot = JSON.parse(readFileSync(pilotReport, "utf8"));
    if (pilot.phase !== "pilot" || pilot.plan_sha256 !== planSha || pilot.task_set_sha256 !== taskSetSha) {
      throw new Error("pilot and main must use the same plan and task set");
    }
    if (pilot.completed_calls !== pilot.scheduled_calls || pilot.stopped_for_cost) {
      throw new Error("main run requires a complete pilot within its cost cap");
    }
  }
  const tasks = new Map(set.tasks.map((task) => [task.id, task]));
  const conditions = new Map(plan.conditions.map((condition) => [condition.id, condition]));
  const schedule = comparisonSchedule(plan, phase);
  if (schedule.length > plan[phase].max_calls) throw new Error("schedule exceeds max_calls");
  if (schedule.some((item) => !tasks.has(item.case_id) || !conditions.has(item.condition_id))) throw new Error("schedule has unknown task or condition");
  const imageFor = (task) => task.image ? plan.image_fixture_overrides?.[task.id] || task.image : null;
  const imageFixtureHashes = Object.fromEntries([...new Set(schedule.map((item) => imageFor(tasks.get(item.case_id))).filter(Boolean))]
    .map((relative) => [relative, hash(readFileSync(path.join(here, relative)))]));
  const worstCost = plan.cost_mode === "subscription" ? null
    : schedule.reduce((sum, item) => sum + maxCallCost(plan, conditions.get(item.condition_id)), 0);
  if (worstCost != null && worstCost > plan[phase].max_estimated_cost_usd) throw new Error("schedule exceeds the estimated cost cap");
  const credentialEnv = plan.providers?.[plan.credential_provider]?.api_key_env;
  const credential = credentialEnv ? process.env[credentialEnv] || resolveCredential(plan.credential_provider) : null;
  if (credentialEnv && !credential) throw new Error(`missing benchmark credential for ${plan.credential_provider}`);
  mkdirSync(outputDir, { recursive: true });
  const project = path.join(outputDir, "project");
  mkdirSync(path.join(project, ".alters"), { recursive: true });
  writeFileSync(path.join(project, ".alters", "config.json"), JSON.stringify({
    default_model: plan.conditions[0].model,
    providers: plan.providers,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
    run_timeout_ms: plan.run.timeout_ms,
  }, null, 2));
  copyFileSync(planInfo.file, path.join(outputDir, "plan.json"));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const records = [];
  const blindPackets = [];
  const blindMap = {};
  const counts = new Map();
  let server = null;
  let knownCost = 0;
  let stoppedForCost = false;
  try {
    if (plan.conditions.some((condition) => condition.attach)) server = await startServer({ environment: process.env });
    for (const entry of schedule) {
      if (performance.now() - started > plan[phase].max_wall_ms) break;
      const condition = conditions.get(entry.condition_id);
      const task = tasks.get(entry.case_id);
      const image = imageFor(task);
      const count = counts.get(condition.id) || 0;
      counts.set(condition.id, count + 1);
      const environment = { ...process.env, ...(credentialEnv ? { [credentialEnv]: credential } : {}) };
      delete environment.OPENCODE_SERVER_URL;
      delete environment.OPENCODE_SERVER_PASSWORD;
      if (condition.attach) Object.assign(environment, server.environment);
      const runtime = createRuntime({ env: environment });
      const startedCall = performance.now();
      const record = {
        case_id: task.id,
        condition_id: condition.id,
        model: condition.model,
        executor: condition.executor,
        repetition: entry.repetition,
        ...(image ? { image_fixture: image } : {}),
        temperature: count === 0 ? "cold" : "warm",
        status: "error",
        run_home: null,
      };
      try {
        const run = await invoke(project, createSpawnOptions({
          name: `${task.id}-${condition.id}-${entry.repetition}`,
          description: "Follow the task directions and return only the answer.",
          prompt: task.prompt,
          images: image ? [path.join(here, image)] : [],
          model: condition.model,
          executor: condition.executor,
          textOnly: true,
          outputContract: task.output_contract || null,
          maxTokens: plan.run.max_tokens,
        }), { runtime });
        const score = scoreTask(task, { ok: run.result.ok, text: run.result.text, tools: run.result.tools });
        const usage = summarizeRunTree(project, run.home);
        Object.assign(record, {
          status: "completed",
          run_home: run.home,
          harness_ok: score.harness_ok,
          quality_score: score.quality_score,
          needs_blinded_review: score.needs_blinded_review,
          wall_ms: run.result.timing?.wall_duration_ms ?? performance.now() - startedCall,
          routing_ms: run.result.routing?.planner_duration_ms ?? 0,
          adviser_ms: run.result.routing?.adviser?.duration_ms ?? null,
          estimated_api_cost_usd: usage.estimated_api_cost_usd,
          tokens: usage.tokens,
          attempts: usage.attempts,
        });
        if (score.needs_blinded_review) {
          const key = hash(`${plan.seed}:${task.id}:${entry.repetition}:${condition.id}`).slice(0, 16);
          blindPackets.push({ review_id: key, ...blindReviewPacket(task, { text: run.result.text }) });
          blindMap[key] = { case_id: task.id, repetition: entry.repetition, condition_id: condition.id };
        }
      } catch (error) {
        record.error_name = error?.name || "Error";
        record.wall_ms = performance.now() - startedCall;
      }
      records.push(record);
      appendFileSync(path.join(outputDir, "records.jsonl"), JSON.stringify(record) + "\n");
      if (record.status === "completed" && plan.cost_mode !== "subscription") {
        if (record.estimated_api_cost_usd == null && maxCallCost(plan, condition) > 0) stoppedForCost = true;
        else knownCost += record.estimated_api_cost_usd || 0;
        if (knownCost > plan[phase].max_estimated_cost_usd) stoppedForCost = true;
      }
      if (stoppedForCost) break;
    }
  } finally {
    await server?.stop();
  }
  const report = {
    schema_version: 1,
    phase,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    task_set_sha256: taskSetSha,
    plan_sha256: planSha,
    model_versions: plan.model_versions,
    image_fixture_sha256: imageFixtureHashes,
    price_source: plan.price_source,
    cost_mode: plan.cost_mode || "api",
    cost_cap_usd: plan[phase].max_estimated_cost_usd,
    worst_case_planned_cost_usd: worstCost,
    scheduled_calls: schedule.length,
    completed_calls: records.length,
    stopped_for_cost: stoppedForCost,
    observed_priced_cost_usd: plan.cost_mode === "subscription" ? null : knownCost,
    exclusions: exclusionsFor(set, phase, new Set(plan[phase].case_ids)),
    analysis: analyzeComparison(records, plan.conditions),
    acceptance: plan.acceptance,
  };
  writeFileSync(path.join(outputDir, "blind-packets.json"), JSON.stringify(blindPackets, null, 2));
  writeFileSync(path.join(outputDir, "blind-map.json"), JSON.stringify(blindMap, null, 2));
  writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  return { outputDir, report, records };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const phase = process.argv.includes("--main") ? "main" : process.argv.includes("--pilot") ? "pilot" : null;
  const value = (flag) => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const result = await runPairedComparison({
    phase,
    planInfo: loadComparisonPlan(value("--plan") || defaultPlan),
    outputDir: value("--output") ? path.resolve(value("--output")) : undefined,
    pilotReport: value("--pilot-report") ? path.resolve(value("--pilot-report")) : null,
  });
  process.stdout.write(JSON.stringify({ output_dir: result.outputDir, report: result.report }, null, 2) + "\n");
}
