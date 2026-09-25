import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { splitModelRef } from "./providers.js";

const TOKEN_KEYS = ["input", "output", "reasoning", "cache_read", "total"];

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const childrenOf = (home) => {
  try {
    return readdirSync(path.join(home, ".alters", "runs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(home, ".alters", "runs", entry.name));
  } catch {
    return [];
  }
};

const deterministic = (attempt) => ["function", "capability"].includes(attempt.executor) || attempt.executor?.startsWith("network-");

const hasUsage = (attempt) =>
  attempt.tokens && ["input", "output", "reasoning", "cache_read", "total"].every((key) =>
    Number.isFinite(attempt.tokens[key]) && attempt.tokens[key] >= 0) &&
  (attempt.tokens.total > 0 || deterministic(attempt));

const costOf = (attempt, providers) => {
  if (!hasUsage(attempt)) return null;
  if (deterministic(attempt) && attempt.tokens.total === 0) return 0;
  let providerId;
  let modelId;
  try {
    ({ providerId, modelId } = splitModelRef(attempt.model));
  } catch {
    return null;
  }
  const provider = providers?.[providerId];
  const cost = Object.hasOwn(attempt, "pricing")
    ? attempt.pricing?.cost
    : provider?.models?.[modelId]?.cost ?? provider?.cost;
  if (!cost || !Number.isFinite(cost.input_per_million) || cost.input_per_million < 0 ||
    !Number.isFinite(cost.output_per_million) || cost.output_per_million < 0) return null;
  const cacheRead = attempt.tokens.cache_read || 0;
  if (cacheRead > 0 && (!Number.isFinite(cost.cache_read_per_million) || cost.cache_read_per_million < 0)) return null;
  const included = attempt.tokens.total === attempt.tokens.input + attempt.tokens.output;
  const separate = attempt.tokens.total >= attempt.tokens.input + cacheRead + attempt.tokens.output;
  if (cacheRead > 0 && !included && !separate) return null;
  if (included && cacheRead > attempt.tokens.input) return null;
  return ((attempt.tokens.input - (included ? cacheRead : 0)) * cost.input_per_million +
    cacheRead * (cost.cache_read_per_million || 0) +
    attempt.tokens.output * cost.output_per_million) / 1_000_000;
};

export const summarizeRunTree = (root, home, { providers = {} } = {}) => {
  const projectRoot = realpathSync(root);
  const seen = new Set();
  const summary = {
    runs: 0,
    attempts: 0,
    max_depth: null,
    tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0])),
    priced_cost_usd: 0,
    estimated_api_cost_usd: null,
    unpriced_attempts: 0,
    missing_token_usage_attempts: 0,
    missing_price_attempts: 0,
    unreported_adviser_decisions: 0,
    incomplete_runs: 0,
    tree_wall_duration_ms: null,
    summed_node_wall_duration_ms: 0,
    missing_timing_runs: 0,
  };
  const visit = (runHome, treeId = null) => {
    let absolute;
    try {
      absolute = realpathSync(runHome);
    } catch {
      summary.incomplete_runs += 1;
      return;
    }
    if (!absolute.startsWith(projectRoot + path.sep)) {
      summary.incomplete_runs += 1;
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const result = readJson(path.join(absolute, "result.json"));
    if (!result) {
      summary.incomplete_runs += 1;
      return;
    }
    if (treeId && result.tree_id !== treeId) return;
    const currentTreeId = treeId || result.tree_id || null;
    if (summary.runs === 0) summary.tree_wall_duration_ms = result.timing?.wall_duration_ms ?? null;
    summary.runs += 1;
    if (Number.isFinite(result.timing?.wall_duration_ms)) {
      summary.summed_node_wall_duration_ms += result.timing.wall_duration_ms;
    } else {
      summary.missing_timing_runs += 1;
    }
    if (Number.isInteger(result.depth)) summary.max_depth = Math.max(summary.max_depth ?? result.depth, result.depth);
    const attempts = result.attempts?.length ? result.attempts : [result];
    for (const attempt of attempts) {
      summary.attempts += 1;
      for (const key of TOKEN_KEYS) summary.tokens[key] += attempt.tokens?.[key] || 0;
      if (!hasUsage(attempt)) summary.missing_token_usage_attempts += 1;
      const cost = costOf(attempt, providers);
      if (cost == null) {
        summary.unpriced_attempts += 1;
        if (hasUsage(attempt)) summary.missing_price_attempts += 1;
      }
      else summary.priced_cost_usd += cost;
    }
    if (result.routing?.adviser) summary.unreported_adviser_decisions += 1;
    const decision = readJson(path.join(absolute, "decision.json"));
    if (decision?.adviser) summary.unreported_adviser_decisions += 1;
    for (const child of childrenOf(absolute)) visit(child, currentTreeId);
    if (typeof decision?.child_home === "string") {
      visit(path.resolve(projectRoot, decision.child_home), currentTreeId);
    }
  };
  visit(home);
  if (summary.missing_timing_runs) summary.summed_node_wall_duration_ms = null;
  if (summary.unpriced_attempts === 0 && summary.unreported_adviser_decisions === 0 && summary.incomplete_runs === 0) {
    summary.estimated_api_cost_usd = summary.priced_cost_usd;
  }
  return summary;
};
