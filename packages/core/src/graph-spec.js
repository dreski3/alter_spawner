import { createSpawnOptions } from "./spawn-spec.js";
import { fail, sanitizeName } from "./util.js";

export const buildGraphSpawnOptions = (node, graphId, mindBinPath) => createSpawnOptions({
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
  catalog: node.catalog ?? null,
  maxTokens: node.maxTokens ?? null,
  fallbackModel: node.fallbackModel ?? null,
  promptPrefix: node.promptPrefix ?? null,
  promptSuffix: node.promptSuffix ?? null,
  webAccess: !!node.webAccess,
  opencodeProvider: node.opencodeProvider || null,
  outputContract: node.outputContract || null,
  mindBinPath,
  spawned_by: `graph:${graphId}`,
  graphId,
  dependsOn: node.depends_on || [],
});

export const validateGraph = (graph) => {
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

export const renderGraphPrompt = (node, records) =>
  node.prompt.replace(/\{\{result:([^}]+)\}\}/g, (_match, id) => records[id].result.text);
