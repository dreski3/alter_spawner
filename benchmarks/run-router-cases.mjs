import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyNetworkDefinition, readNetworkDefinition } from "../packages/core/src/index.js";
import { runLayaRouterDemo } from "../examples/laya-router/run-demo.mjs";
import { setupLayaRouter } from "../examples/laya-router/setup.mjs";
import { loadTaskSet } from "./task-set.mjs";

const targetFor = (route) => route === "uppercase" ? "uppercase-tool" : route;

export const runRouterCases = async ({ cases = loadTaskSet().set.router_cases, keepRuns = false } = {}) => {
  const records = [];
  for (const item of cases) {
    const root = mkdtempSync(path.join(tmpdir(), "mind-router-benchmark-"));
    try {
      setupLayaRouter(root);
      if (item.fallback_route) {
        const network = readNetworkDefinition(root);
        applyNetworkDefinition(root, {
          ...network,
          components: network.components.map((component) => component.id === "router"
            ? { ...component, router: { ...component.router, fallback_route: item.fallback_route } }
            : component),
        }, { expectedRevision: network.revision });
      }
      const adviserInputs = [];
      const decide = async (request) => {
        adviserInputs.push(request);
        if (item.adviser.behavior === "valid") return { id: item.adviser.route };
        if (item.adviser.behavior === "out_of_set") return { id: "outside-route-set" };
        if (item.adviser.behavior === "timeout") throw new Error("decision timed out");
        throw new Error("adviser unavailable");
      };
      const run = await runLayaRouterDemo(root, {
        routingSignal: item.signal,
        payload: item.payload,
        advisers: { "laya-mlx": { decide } },
      });
      const decisionText = readFileSync(path.join(run.home, "decision.json"), "utf8");
      const selected = run.decision.selected_route_id;
      const expectedWorkerCount = selected == null ? 0 : 1;
      const isolation = adviserInputs.length === 1 && adviserInputs[0].signal === item.signal &&
        !JSON.stringify(adviserInputs[0]).includes(item.payload) &&
        run.calls.length === expectedWorkerCount &&
        (selected == null || (run.calls[0].target === targetFor(selected) && run.calls[0].payload === item.payload)) &&
        !decisionText.includes(item.payload) && !decisionText.includes(item.payload.match(/CANARY_[A-Z0-9_]+/)[0]);
      const passed = isolation && selected === item.expected_selected_route &&
        run.decision.adviser_outcome === item.expected_outcome &&
        (selected == null || item.expected_routes.includes(selected)) &&
        run.result.ok === (selected != null);
      records.push({
        case_id: item.id,
        split: item.split,
        passed,
        isolation,
        selected_route: selected,
        adviser_outcome: run.decision.adviser_outcome,
        wrong_route: selected != null && !item.expected_routes.includes(selected),
        run_home: keepRuns ? run.home : null,
        tree_usage: run.treeUsage,
        network_wall_duration_ms: run.networkTiming.wall_duration_ms,
      });
    } finally {
      if (!keepRuns) rmSync(root, { recursive: true, force: true });
    }
  }
  return { cases: records, passed: records.every((record) => record.passed) };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { sha256 } = loadTaskSet();
  const report = await runRouterCases({ keepRuns: process.argv.includes("--keep-runs") });
  process.stdout.write(JSON.stringify({ task_set_sha256: sha256, ...report }, null, 2) + "\n");
  if (!report.passed) process.exitCode = 1;
}
