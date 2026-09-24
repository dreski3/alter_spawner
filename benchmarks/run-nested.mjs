import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntime, createSpawnOptions, HARNESS_ADAPTERS, registerHarness, spawnAlter, summarizeRunTree } from "../packages/core/src/index.js";
import { loadTaskSet } from "./task-set.mjs";

const tokens = () => ({ input: 2, output: 1, reasoning: 0, cache_read: 0, total: 3 });
const expectedNodes = (item) => item.shape === "chain" ? item.max_depth + 1 : 2 * item.max_depth + 1;
const matches = (fault, node) => fault?.depth === node.depth && fault.branch === node.branch;

const collectRuns = (home, treeId, results = []) => {
  const file = path.join(home, "result.json");
  if (!existsSync(file)) return results;
  const result = JSON.parse(readFileSync(file, "utf8"));
  if (result.tree_id !== treeId) return results;
  results.push(result);
  const children = path.join(home, ".alters", "runs");
  if (existsSync(children)) {
    for (const name of readdirSync(children)) collectRuns(path.join(children, name), treeId, results);
  }
  return results;
};

export const runNestedWorkload = async (item, { keepRun = false } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-nested-benchmark-"));
  const executor = `benchmark-nested-${randomUUID().slice(0, 12)}`;
  try {
    mkdirSync(path.join(root, ".alters"));
    writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
      default_model: "benchmark/mock",
      max_depth: item.max_depth + 2,
      max_tree_nodes: expectedNodes(item),
      max_concurrent_alters: 1,
      retry: { same_harness_retries: 1, fallback_retries: 0 },
      providers: { benchmark: { models: { mock: { cost: { input_per_million: 0, output_per_million: 0 } } } } },
    }));
    registerHarness(executor, {
      async run(home, prompt, options) {
        const node = JSON.parse(prompt);
        if (matches(item.retry, node) && options.attempt === 1) {
          return { ok: false, text: "retry requested", tokens: tokens(), steps: 1, exitCode: 1, killed: false, budget_exceeded: false, empty_output: false, sessionID: null };
        }
        if (matches(item.failure, node)) {
          return { ok: false, text: "injected failure", tokens: tokens(), steps: 1, exitCode: 1, killed: false, budget_exceeded: true, empty_output: false, sessionID: null };
        }
        if (node.branch === "spine" && node.depth < item.max_depth) {
          const children = [{ branch: "spine", depth: node.depth + 1 }];
          if (item.shape === "branch") children.push({ branch: "side", depth: node.depth + 1 });
          await Promise.all(children.map((child) => spawnAlter(home, createSpawnOptions({
            name: `${child.branch}-${child.depth}`,
            prompt: JSON.stringify(child),
            model: "benchmark/mock",
            executor,
            nestable: child.branch === "spine" && child.depth < item.max_depth,
          }), { runtime: createRuntime({ env: {
            ...options.environment,
            ALTER_DEPTH: String(options.depth),
            ALTER_ID: options.alterId,
          } }) })));
        }
        return { ok: true, text: "done", tokens: tokens(), steps: 1, exitCode: 0, killed: false, budget_exceeded: false, empty_output: false, sessionID: null };
      },
    });
    const run = await spawnAlter(root, createSpawnOptions({
      name: "spine-0",
      prompt: JSON.stringify({ branch: "spine", depth: 0 }),
      model: "benchmark/mock",
      executor,
      nestable: true,
    }));
    const treeUsage = summarizeRunTree(root, run.home);
    const results = collectRuns(run.home, run.result.tree_id);
    const perDepth = Array.from({ length: item.max_depth + 1 }, (_, depth) => {
      const nodes = results.filter((result) => result.depth === depth);
      return {
        depth,
        nodes: nodes.length,
        attempts: nodes.reduce((sum, result) => sum + (result.attempts?.length || 0), 0),
        retries: nodes.reduce((sum, result) => sum + (result.attempts?.filter((attempt) => attempt.reason !== "initial").length || 0), 0),
        queue_ms: nodes.reduce((sum, result) => sum + (result.timing?.queue_ms || 0), 0),
        admission_ms: nodes.reduce((sum, result) => sum + (result.timing?.admission_ms || 0), 0),
        tokens: nodes.reduce((sum, result) => sum + (result.attempts || []).reduce((spent, attempt) => spent + (attempt.tokens?.total || 0), 0), 0),
        failed_nodes: nodes.filter((result) => !result.ok).length,
      };
    });
    const totalRetries = perDepth.reduce((sum, depth) => sum + depth.retries, 0);
    const totalFailures = perDepth.reduce((sum, depth) => sum + depth.failed_nodes, 0);
    const passed = treeUsage.runs === expectedNodes(item) && treeUsage.max_depth === item.max_depth &&
      treeUsage.attempts === expectedNodes(item) + Number(!!item.retry) &&
      treeUsage.tokens.total === 3 * treeUsage.attempts &&
      totalRetries === Number(!!item.retry) && totalFailures === Number(!!item.failure) &&
      treeUsage.incomplete_runs === 0;
    return {
      case_id: item.id,
      split: item.split,
      shape: item.shape,
      max_depth: item.max_depth,
      passed,
      run_home: keepRun ? run.home : null,
      tree_usage: treeUsage,
      per_depth: perDepth,
    };
  } finally {
    HARNESS_ADAPTERS.delete(executor);
    if (!keepRun) rmSync(root, { recursive: true, force: true });
  }
};

export const runNestedMatrix = async ({ workloads = loadTaskSet().set.nested_workloads, keepRuns = false } = {}) => {
  const cases = [];
  for (const item of workloads) cases.push(await runNestedWorkload(item, { keepRun: keepRuns }));
  return { cases, passed: cases.every((item) => item.passed) };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { sha256 } = loadTaskSet();
  const report = await runNestedMatrix({ keepRuns: process.argv.includes("--keep-runs") });
  process.stdout.write(JSON.stringify({ task_set_sha256: sha256, ...report }, null, 2) + "\n");
  if (!report.passed) process.exitCode = 1;
}
