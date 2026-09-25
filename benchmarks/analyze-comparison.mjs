const finite = (value) => typeof value === "number" && Number.isFinite(value);

export const percentile = (values, rank) => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (rank === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
};

const rate = (values) => values.length ? values.filter(Boolean).length / values.length : null;

export const summarizeCondition = (records) => {
  const completed = records.filter((record) => record.status === "completed");
  const scored = completed.filter((record) => finite(record.quality_score));
  const autoScored = scored.filter((record) => !record.needs_blinded_review);
  const reviewed = scored.filter((record) => record.needs_blinded_review);
  const priced = completed.filter((record) => finite(record.estimated_api_cost_usd));
  const routed = completed.filter((record) => typeof record.wrong_route === "boolean");
  const adviser = completed.filter((record) => typeof record.invalid_choice === "boolean");
  const isolated = completed.filter((record) => typeof record.payload_isolation_failure === "boolean");
  return {
    samples: records.length,
    completed: completed.length,
    median_wall_ms: percentile(completed.map((record) => record.wall_ms), 0.5),
    p95_wall_ms: percentile(completed.map((record) => record.wall_ms), 0.95),
    median_routing_ms: percentile(completed.map((record) => record.routing_ms), 0.5),
    p95_routing_ms: percentile(completed.map((record) => record.routing_ms), 0.95),
    estimated_api_cost_usd: priced.length === completed.length && completed.length
      ? priced.reduce((sum, record) => sum + record.estimated_api_cost_usd, 0) : null,
    priced_samples: priced.length,
    harness_success_rate: rate(records.map((record) => record.status === "completed" && record.harness_ok === true)),
    quality_rate: scored.length ? scored.reduce((sum, record) => sum + record.quality_score, 0) / scored.length : null,
    scored_samples: scored.length,
    auto_quality_rate: autoScored.length ? autoScored.reduce((sum, record) => sum + record.quality_score, 0) / autoScored.length : null,
    auto_scored_samples: autoScored.length,
    reviewed_samples: reviewed.length,
    blind_review_pending: completed.filter((record) => record.needs_blinded_review && !finite(record.quality_score)).length,
    wrong_route_rate: rate(routed.map((record) => record.wrong_route)),
    invalid_choice_rate: rate(adviser.map((record) => record.invalid_choice)),
    payload_isolation_failures: isolated.length ? isolated.filter((record) => record.payload_isolation_failure).length : null,
    routing_samples: routed.length,
  };
};

export const analyzeComparison = (records, conditions) => {
  const byCondition = {};
  for (const condition of conditions) {
    const own = records.filter((record) => record.condition_id === condition.id);
    byCondition[condition.id] = {
      all: summarizeCondition(own),
      cold: summarizeCondition(own.filter((record) => record.temperature === "cold")),
      warm: summarizeCondition(own.filter((record) => record.temperature === "warm")),
    };
  }
  const pairs = [];
  for (const baseline of conditions) {
    if (baseline.executor !== "llm" && !(baseline.executor === "opencode" && baseline.attach)) continue;
    for (const candidate of conditions.filter((item) => item.id !== baseline.id && item.pair_group === baseline.pair_group &&
      item.model === baseline.model && (baseline.executor === "llm" || (item.executor === "opencode" && !item.attach)))) {
      const matched = [];
      for (const left of records.filter((record) => record.condition_id === baseline.id && record.status === "completed")) {
        const right = records.find((record) => record.condition_id === candidate.id && record.case_id === left.case_id &&
          record.repetition === left.repetition && record.status === "completed");
        if (right) matched.push({ left, right });
      }
      pairs.push({
        baseline: baseline.id,
        candidate: candidate.id,
        model: baseline.model,
        samples: matched.length,
        median_wall_delta_ms: percentile(matched.map(({ left, right }) => right.wall_ms - left.wall_ms), 0.5),
        median_cost_delta_usd: percentile(matched.map(({ left, right }) =>
          finite(left.estimated_api_cost_usd) && finite(right.estimated_api_cost_usd)
            ? right.estimated_api_cost_usd - left.estimated_api_cost_usd : null), 0.5),
        auto_quality_delta: matched.filter(({ left, right }) => finite(left.quality_score) && finite(right.quality_score)).length
          ? matched.filter(({ left, right }) => finite(left.quality_score) && finite(right.quality_score))
            .reduce((sum, { left, right }) => sum + right.quality_score - left.quality_score, 0) /
            matched.filter(({ left, right }) => finite(left.quality_score) && finite(right.quality_score)).length
          : null,
      });
    }
  }
  return { conditions: byCondition, pairs };
};
