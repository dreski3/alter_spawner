import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { spawnAlter } from "./engine.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { GRAPH_RESULT_SCHEMA_VERSION } from "./persistence.js";
import { fail, iso, sanitizeName, timestampSlug } from "./util.js";

const defaultSpawnOptions = (node, graphId, mindBinPath) => createSpawnOptions({
  name: node.id,
  description: node.description ?? null,
  model: node.model ?? null,
  prompt: node.prompt,
  readGrants: node.readGrants || [],
  writeGrants: node.writeGrants || [],
  bashAllow: node.bashAllow || [],
  bashOnly: !!node.bashOnly,
  nestable: !!node.nestable,
  timeout: node.timeout ?? null,
  rm: false,
  verbose: false,
  catalog: node.catalog ?? null,
  maxTokens: node.maxTokens ?? null,
  fallbackModel: node.fallbackModel ?? null,
  promptPrefix: node.promptPrefix ?? null,
  promptSuffix: node.promptSuffix ?? null,
  webAccess: !!node.webAccess,
  opencodeProvider: node.opencodeProvider || null,
  mindBinPath,
  spawned_by: `graph:${graphId}`,
  graphId,
  dependsOn: node.depends_on || [],
});

const validateGraph = (graph) => {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    fail("alter graph requires a non-empty nodes array.");
  }
  const nodes = new Map();
  for (const node of graph.nodes) {
    const id = sanitizeName(node?.id);
    if (!id || id !== node.id) fail(`invalid graph node id: ${node?.id ?? "(missing)"}`);
    if (nodes.has(id)) fail(`duplicate graph node id: ${id}`);
    if (typeof node.prompt !== "string" || !node.prompt.trim()) fail(`graph node "${id}" requires a prompt.`);
    nodes.set(id, { ...node, depends_on: node.depends_on || [] });
  }
  for (const node of nodes.values()) {
    for (const dependency of node.depends_on) {
      if (!nodes.has(dependency)) fail(`graph node "${node.id}" has unknown dependency "${dependency}".`);
      if (dependency === node.id) fail(`graph node "${node.id}" cannot depend on itself.`);
    }
    for (const match of node.prompt.matchAll(/\{\{result:([^}]+)\}\}/g)) {
      if (!node.depends_on.includes(match[1])) {
        fail(`graph node "${node.id}" references "${match[1]}" without declaring it in depends_on.`);
      }
    }
  }
  const output = graph.output || graph.nodes[graph.nodes.length - 1].id;
  if (!nodes.has(output)) fail(`unknown graph output node: ${output}`);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail(`alter graph contains a dependency cycle at "${id}".`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
  return { nodes, output };
};

const renderPrompt = (node, records) =>
  node.prompt.replace(/\{\{result:([^}]+)\}\}/g, (_match, id) => records[id].result.text);

const publicRecord = (record) => ({
  id: record.id,
  state: record.state,
  depends_on: record.depends_on,
  home: record.home || null,
  result: record.result || null,
  error: record.error || null,
});

const aggregateTokens = (records) => {
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 };
  for (const record of Object.values(records)) {
    const attempts = record.result?.attempts || [];
    const usages = attempts.length ? attempts.map((attempt) => attempt.tokens) : [record.result?.tokens];
    for (const usage of usages) {
      if (!usage) continue;
      for (const key of Object.keys(tokens)) tokens[key] += usage[key] || 0;
    }
  }
  return tokens;
};

export const runAlterGraph = async (
  root,
  graph,
  { harness = "opencode", signal, concurrency = Infinity, mindBinPath = null } = {},
) => {
  const { nodes, output } = validateGraph(graph);
  const graphId = sanitizeName(graph.id || `graph_${Math.random().toString(36).slice(2, 8)}`);
  const graphRoot = path.join(kitDir(root), "graphs");
  let graphHome = path.join(graphRoot, `${timestampSlug()}_${graphId}`);
  if (existsSync(graphHome)) {
    graphHome = path.join(graphRoot, `${timestampSlug()}_${graphId}-${Math.random().toString(36).slice(2, 8)}`);
  }
  mkdirSync(graphHome, { recursive: true });
  const startMs = Date.now();
  const startedAt = iso(startMs);
  const records = Object.fromEntries(
    [...nodes.values()].map((node) => [
      node.id,
      { id: node.id, state: "pending", depends_on: node.depends_on, home: null, result: null, error: null },
    ])
  );
  const persist = (endedAt = null) => {
    const values = Object.values(records);
    const outputRecord = records[output];
    const document = {
      schema_version: GRAPH_RESULT_SCHEMA_VERSION,
      id: graphId,
      ok: values.every((record) => record.state === "succeeded"),
      state: endedAt ? "completed" : "running",
      output_node: output,
      output: outputRecord.result?.text || null,
      tokens: aggregateTokens(records),
      node_counts: {
        total: values.length,
        succeeded: values.filter((record) => record.state === "succeeded").length,
        failed: values.filter((record) => record.state === "failed").length,
        skipped: values.filter((record) => record.state === "skipped").length,
      },
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt ? Date.now() - startMs : null,
      nodes: Object.fromEntries(values.map((record) => [record.id, publicRecord(record)])),
    };
    writeFileSync(path.join(graphHome, "result.json"), JSON.stringify(document, null, 2) + "\n");
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
            const options = defaultSpawnOptions(
              { ...node, prompt: renderPrompt(node, records) },
              graphId,
              mindBinPath
            );
            const spawned = await spawnAlter(root, options, { harness, signal });
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
  const result = persist(iso(Date.now()));
  return { home: graphHome, result };
};
