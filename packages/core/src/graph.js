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
  {
    harness = null,
    signal,
    concurrency = Infinity,
    mindBinPath = null,
    runtime: runtimeOverride,
    // Called with the whole graph document on every state transition, on the same
    // schedule as the result.json write. A host rendering a graph live has otherwise
    // nothing to render until the last node returns: the document on disk is current
    // throughout, but there is no way to know when it changed without polling a
    // directory whose name is not known until this function returns.
    onProgress,
    // Forwarded to every node's spawnAlter. Node-level events carry no node id of
    // their own, so the id is added here — without it a host with four nodes in flight
    // cannot tell which one is streaming.
    onEvent,
  } = {},
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
    // After the write, so a host that reacts by reading the file sees what it was
    // told about. Isolated: a throwing observer is a bug in the host, not a reason
    // to abandon a graph whose nodes have already done their work.
    if (onProgress) {
      try {
        onProgress(document);
      } catch {}
    }
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
            const truncatedEdges = [];
            const options = buildGraphSpawnOptions(
              {
                ...node,
                prompt: renderGraphPrompt(node, records, {
                  maxEdgeChars: graph.max_edge_chars === undefined ? undefined : graph.max_edge_chars,
                  onTruncate: (edge) => truncatedEdges.push(edge),
                }),
              },
              graphId,
              mindBinPath
            );
            // Recorded on the node that received the shortened input, so the trace
            // shows which prompt was cut rather than leaving it to be inferred.
            if (truncatedEdges.length) record.truncated_edges = truncatedEdges;
            const spawned = await spawnAlter(root, options, {
              harness,
              signal,
              runtime,
              onEvent: onEvent ? (event) => onEvent({ ...event, node: id }) : undefined,
            });
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
