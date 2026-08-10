import { mkdirSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { spawnAlter } from "./engine.js";
import { buildGraphSpawnOptions, renderGraphPrompt, validateGraph } from "./graph-spec.js";
import { createGraphResult } from "./graph-result.js";
import { runMemoryCurator, runMemoryRecall } from "./memory-workflows.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso, sanitizeName, timestampSlug } from "./util.js";

// "alter run failed" was the same sentence whether the model refused, returned
// nothing, broke its contract, or answered perfectly and got charged for reasoning
// tokens it was never given room for. That last case is the one worth naming: a node
// whose text is exactly right still fails, and reading the message told you nothing
// about which knob to turn. So the budget failure reports the numbers that caused it.
export const describeAlterFailure = (result) => {
  if (result.budget_exceeded) {
    const total = result.tokens?.total ?? 0;
    const reasoning = result.tokens?.reasoning ?? 0;
    const reasoningNote = reasoning ? `, ${reasoning} of them reasoning` : "";
    return `exceeded its ${result.max_tokens}-token budget (used ${total}${reasoningNote}) — raise maxTokens`;
  }
  if (result.contract_failed) return `output contract not met: ${result.contract_error || "no reason given"}`;
  if (result.empty_output) return "returned no output";
  if (result.aborted) return "cancelled before it finished";
  if (result.killed) return "timed out and was killed";
  if (result.llm_error) return result.llm_error;
  return "alter run failed";
};

// Same race, and the same fix, as claimRunFolder in scaffold.js: the graph home's name
// is a second-resolution timestamp plus a caller-supplied id, so two graphs started on
// one tick name the same directory. Claim it by creating it non-recursively and let
// EEXIST drive the retry.
const claimGraphHome = (graphRoot, graphId, runtime) => {
  mkdirSync(graphRoot, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const suffix = i === 0 ? "" : `-${runtime.randomId(6)}`;
    const home = path.join(graphRoot, `${timestampSlug(runtime.now())}_${graphId}${suffix}`);
    try {
      mkdirSync(home);
      return home;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("could not allocate a unique graph home for: " + graphId);
};

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
    memory = null,
  } = {},
) => {
  const runtime = resolveRuntime(runtimeOverride);
  const { nodes, output } = validateGraph(graph);
  const graphId = sanitizeName(graph.id || `graph_${runtime.randomId(6)}`);
  const graphRoot = path.join(kitDir(root), "graphs");
  const graphHome = claimGraphHome(graphRoot, graphId, runtime);
  const startMs = runtime.now();
  const startedAt = iso(startMs);
  const memoryCycle = [...nodes.values()].some((node) => node.memory)
    ? {
      id: `memory_cycle_${runtime.randomId(12)}`,
      consistency: "next-cycle",
      state: "preparing",
      recalled_records: 0,
      curated_records: 0,
    }
    : null;
  const records = Object.fromEntries(
    [...nodes.values()].map((node) => [
      node.id,
      {
        id: node.id,
        state: "pending",
        depends_on: node.depends_on,
        home: null,
        result: null,
        error: null,
        memory: node.memory ? {
          recall: node.memory.recall ? { state: "pending", namespace: node.memory.recall.namespace || null, record_ids: [], error: null } : null,
          curate: node.memory.curate ? { state: "pending", namespace: node.memory.curate.namespace || null, record_ids: [], error: null } : null,
        } : null,
      },
    ])
  );
  const persist = (endedAt = null) => {
    const document = createGraphResult({ graphId, output, records, memoryCycle, startedAt, startMs, endedAt, now: runtime.now() });
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
  const recalledContexts = new Map();
  const recallWorkflow = memory?.recall || runMemoryRecall;
  const curateWorkflow = memory?.curate || runMemoryCurator;
  const memoryScope = memory?.scope || null;
  if (memoryCycle) {
    await Promise.all([...nodes.values()].filter((node) => node.memory?.recall).map(async (node) => {
      const trace = records[node.id].memory.recall;
      trace.state = "running";
      persist();
      try {
        if (!memoryScope) throw new Error("graph memory hooks require options.memory.scope");
        const recalled = await recallWorkflow(root, {
          prompt: node.memory.recall.query || node.prompt,
          scope: { ...memoryScope, ...(node.memory.recall.namespace ? { namespace: node.memory.recall.namespace } : {}) },
          approvals: memory?.recallApprovals,
          signal,
          onEvent: onEvent ? (event) => onEvent({ ...event, node: node.id, memory: "recall" }) : undefined,
          runtime,
          harness,
        });
        recalledContexts.set(node.id, recalled.context || "");
        trace.record_ids = recalled.results?.map((result) => result.record.id) || [];
        trace.state = "succeeded";
        memoryCycle.recalled_records += trace.record_ids.length;
      } catch (error) {
        trace.state = "failed";
        trace.error = error instanceof Error ? error.message : String(error);
      }
      persist();
    }));
    memoryCycle.state = "running";
    persist();
  }
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : nodes.size;
  const pending = new Set(nodes.keys());
  const curationJobs = [];
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
            if (recalledContexts.get(id)) options.prompt += recalledContexts.get(id);
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
            if (!spawned.result.ok) record.error = describeAlterFailure(spawned.result);
            if (spawned.result.ok && node.memory?.curate) {
              const trace = record.memory.curate;
              trace.state = "queued";
              curationJobs.push(async () => {
                trace.state = "running";
                persist();
                try {
                  if (!memoryScope) throw new Error("graph memory hooks require options.memory.scope");
                  const curated = await curateWorkflow(root, {
                    content: spawned.result.text,
                    scope: { ...memoryScope, ...(node.memory.curate.namespace ? { namespace: node.memory.curate.namespace } : {}) },
                    source: { runId: spawned.result.id || null, catalogId: node.catalog || null },
                    approvals: memory?.curateApprovals,
                    signal,
                    onEvent: onEvent ? (event) => onEvent({ ...event, node: id, memory: "curate" }) : undefined,
                    runtime,
                    harness,
                  });
                  trace.record_ids = curated.records?.map((memoryRecord) => memoryRecord.id) || [];
                  trace.state = "succeeded";
                  memoryCycle.curated_records += trace.record_ids.length;
                } catch (error) {
                  trace.state = "failed";
                  trace.error = error instanceof Error ? error.message : String(error);
                }
                persist();
              });
            }
          } catch (error) {
            record.state = "failed";
            record.error = error instanceof Error ? error.message : String(error);
          }
          persist();
        })
      );
    }
  }
  await Promise.all(curationJobs.map((run) => run()));
  if (memoryCycle) memoryCycle.state = "completed";
  const result = persist(iso(runtime.now()));
  return { home: graphHome, result };
};
