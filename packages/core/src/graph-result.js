import { GRAPH_RESULT_SCHEMA_VERSION } from "./persistence.js";

const publicRecord = (record) => ({
  id: record.id,
  state: record.state,
  depends_on: record.depends_on,
  home: record.home || null,
  result: record.result || null,
  error: record.error || null,
  truncated_edges: record.truncated_edges || null,
  memory: record.memory || null,
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

export const createGraphResult = ({ graphId, output, records, memoryCycle = null, startedAt, startMs, endedAt = null, now = Date.now() }) => {
  const values = Object.values(records);
  const outputRecord = records[output];
  return {
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
    duration_ms: endedAt ? now - startMs : null,
    memory_cycle: memoryCycle,
    nodes: Object.fromEntries(values.map((record) => [record.id, publicRecord(record)])),
  };
};
