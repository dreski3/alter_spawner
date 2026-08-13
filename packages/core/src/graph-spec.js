import { createSpawnOptions } from "./spawn-spec.js";
import { fail, sanitizeName } from "./util.js";

export const buildGraphSpawnOptions = (node, graphId, mindBinPath) => createSpawnOptions({
  name: node.id,
  description: node.description ?? null,
  model: node.model ?? null,
  prompt: node.prompt,
  images: node.images || [],
  readGrants: node.readGrants || [],
  writeGrants: node.writeGrants || [],
  bashAllow: node.bashAllow || [],
  bashOnly: !!node.bashOnly,
  textOnly: !!node.textOnly,
  // A graph is the natural place for mixed executors: a reasoning node and the leaf
  // transformers hanging off it need not run on the same machinery.
  executor: node.executor ?? null,
  capability: node.capability ?? null,
  nestable: !!node.nestable,
  timeout: node.timeout ?? null,
  catalog: node.catalog ?? null,
  maxTokens: node.maxTokens ?? null,
  fallbackModel: node.fallbackModel ?? null,
  promptPrefix: node.promptPrefix ?? null,
  promptSuffix: node.promptSuffix ?? null,
  webAccess: !!node.webAccess,
  opencodeProvider: node.opencodeProvider || null,
  opencodeVariant: node.opencodeVariant || null,
  outputContract: node.outputContract || null,
  mindBinPath,
  spawned_by: `graph:${graphId}`,
  graphId,
  dependsOn: node.depends_on || [],
});

const normalizeMemoryHook = (value, label, fields) => {
  if (value === undefined || value === false) return null;
  if (value === true) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be true, false, or an object.`);
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key));
  if (unexpected.length) fail(`${label}.${unexpected[0]} is not allowed.`);
  if (value.namespace !== undefined && (typeof value.namespace !== "string" || !value.namespace.trim())) {
    fail(`${label}.namespace must be a non-empty string.`);
  }
  if (value.query !== undefined && (typeof value.query !== "string" || !value.query.trim())) {
    fail(`${label}.query must be a non-empty string.`);
  }
  return Object.freeze({
    ...(value.namespace === undefined ? {} : { namespace: value.namespace.trim() }),
    ...(value.query === undefined ? {} : { query: value.query.trim() }),
  });
};

export const normalizeGraphNodeMemory = (memory, nodeId = "node") => {
  if (memory === undefined || memory === null || memory === false) return null;
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) fail(`graph node "${nodeId}" memory must be an object.`);
  const unexpected = Object.keys(memory).filter((key) => !["recall", "curate"].includes(key));
  if (unexpected.length) fail(`graph node "${nodeId}" memory.${unexpected[0]} is not allowed.`);
  const recall = normalizeMemoryHook(memory.recall, `graph node "${nodeId}" memory.recall`, ["namespace", "query"]);
  const curate = normalizeMemoryHook(memory.curate, `graph node "${nodeId}" memory.curate`, ["namespace"]);
  if (!recall && !curate) return null;
  return Object.freeze({ recall, curate });
};

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
    if (node.images != null && (!Array.isArray(node.images) || node.images.some((image) => typeof image !== "string" || !image.trim()))) {
      fail(`graph node "${id}" images must be an array of non-empty file paths.`);
    }
    nodes.set(id, { ...node, depends_on: node.depends_on || [], memory: normalizeGraphNodeMemory(node.memory, id) });
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

// A dependency's whole result is pasted into its dependents' prompts, so in a deep
// pipeline the payload compounds: a node that fans into three dependents hands each
// of them everything it produced, and their outputs carry it forward again. Nothing
// bounded that, which is how a graph that looks small on paper ends up sending the
// same text a dozen times.
//
// 32k characters is roughly 8k tokens — far more than any single dependency payload
// should be, while still stopping the compounding case. Truncation is deliberately
// loud: a marker lands in the prompt itself and `onTruncate` records it in the graph
// trace, because a silently shortened input reads downstream as a complete one.
// Set `max_edge_chars: null` on the graph to turn it off.
export const DEFAULT_MAX_EDGE_CHARS = 32000;

export const renderGraphPrompt = (node, records, { maxEdgeChars = DEFAULT_MAX_EDGE_CHARS, onTruncate } = {}) =>
  node.prompt.replace(/\{\{result:([^}]+)\}\}/g, (_match, id) => {
    const text = records[id].result.text;
    if (maxEdgeChars == null || typeof text !== "string" || text.length <= maxEdgeChars) return text;
    onTruncate?.({ from: id, to: node.id, kept: maxEdgeChars, total: text.length });
    return `${text.slice(0, maxEdgeChars)}\n\n[truncated: ${maxEdgeChars} of ${text.length} characters from "${id}"]`;
  });
