import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { spawnAlter } from "./engine.js";
import { buildGraphSpawnOptions, renderGraphPrompt, validateGraph } from "./graph-spec.js";
import { createGraphResult } from "./graph-result.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso, sanitizeName, timestampSlug } from "./util.js";

export const runAlterGraph = async (
  root,
  graph,
  { harness = "opencode", signal, concurrency = Infinity, mindBinPath = null, runtime: runtimeOverride } = {},
) => {
  const runtime = resolveRuntime(runtimeOverride);
  const { nodes, output } = validateGraph(graph);
  const graphId = sanitizeName(graph.id || `graph_${runtime.randomId(6)}`);
  const graphRoot = path.join(kitDir(root), "graphs");
  let graphHome = path.join(graphRoot, `${timestampSlug(runtime.now())}_${graphId}`);
  if (existsSync(graphHome)) {
    graphHome = path.join(graphRoot, `${timestampSlug(runtime.now())}_${graphId}-${runtime.randomId(6)}`);
  }
  mkdirSync(graphHome, { recursive: true });
  const startMs = runtime.now();
  const startedAt = iso(startMs);
  const records = Object.fromEntries(
    [...nodes.values()].map((node) => [
      node.id,
      { id: node.id, state: "pending", depends_on: node.depends_on, home: null, result: null, error: null },
    ])
  );
  const persist = (endedAt = null) => {
    const document = createGraphResult({ graphId, output, records, startedAt, startMs, endedAt, now: runtime.now() });
    writeJsonAtomic(path.join(graphHome, "result.json"), document);
    return document;
  };
  persist();
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : nodes.size;
  const pending = new Set(nodes.keys());
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      nodes.get(id).depends_on.every((dependency) => records[dependency].state !== "pending" && records[dependency].state !== "running")
    );
    if (ready.length === 0) fail("alter graph scheduler reached an invalid state.");
    for (let offset = 0; offset < ready.length; offset += limit) {
      const batch = ready.slice(offset, offset + limit);
      await Promise.all(
        batch.map(async (id) => {
          pending.delete(id);
          const node = nodes.get(id);
          const record = records[id];
          if (signal?.aborted) {
            record.state = "skipped";
            record.error = "graph aborted";
            persist();
            return;
          }
          const failedDependency = node.depends_on.find((dependency) => records[dependency].state !== "succeeded");
          if (failedDependency) {
            record.state = "skipped";
            record.error = `dependency "${failedDependency}" did not succeed`;
            persist();
            return;
          }
          record.state = "running";
          persist();
          try {
            const options = buildGraphSpawnOptions(
              { ...node, prompt: renderGraphPrompt(node, records) },
              graphId,
              mindBinPath
            );
            const spawned = await spawnAlter(root, options, { harness, signal, runtime });
            record.home = spawned.home;
            record.result = spawned.result;
            record.state = spawned.result.ok ? "succeeded" : "failed";
            if (!spawned.result.ok) record.error = "alter run failed";
          } catch (error) {
            record.state = "failed";
            record.error = error instanceof Error ? error.message : String(error);
          }
          persist();
        })
      );
    }
  }
  const result = persist(iso(runtime.now()));
  return { home: graphHome, result };
};
