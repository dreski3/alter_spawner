import {
  describeAlterFailure,
  fail,
  loadModelsCatalog,
  modelsCatalogPath,
  readConfig,
  requireProjectRoot,
  spawnAlter,
  splitModelRef,
} from "@mind/core";
import path from "node:path";
import { parseSpawnArgs } from "../parseArgs.js";

const count = (value) => new Intl.NumberFormat("en-US").format(value || 0);

const duration = (ms) => {
  const seconds = Math.floor((ms || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${seconds}s`;
};

const pricingFor = (model, catalog, providers) => {
  try {
    const { providerId, modelId } = splitModelRef(model);
    const configured = providers?.[providerId]?.models?.[modelId]?.cost || providers?.[providerId]?.cost;
    if (configured) {
      return {
        input: configured.input_per_million,
        output: configured.output_per_million,
        cache_read: configured.cache_read_per_million,
      };
    }
    return catalog?.[providerId]?.models?.[modelId]?.cost || null;
  } catch {
    return null;
  }
};

const estimateCost = (attempt, catalog, providers) => {
  const tokens = attempt.tokens || {};
  const rates = pricingFor(attempt.model, catalog, providers);
  if (!rates) return null;
  const categories = [
    [tokens.input || 0, rates.input],
    [tokens.output || 0, rates.output],
    [tokens.cache_read || 0, rates.cache_read],
  ];
  if (categories.some(([used, rate]) => used > 0 && !(typeof rate === "number" && Number.isFinite(rate) && rate >= 0))) return null;
  return categories.reduce((sum, [used, rate]) => sum + (used * (rate || 0)) / 1_000_000, 0);
};

const formatCost = (value) => value == null
  ? "unavailable"
  : `$${value.toFixed(6)}`;

const printExecutionSummary = (id, result, fallback, root) => {
  let catalog = null;
  try {
    catalog = loadModelsCatalog(modelsCatalogPath(process.env));
  } catch {}
  let providers = {};
  try {
    providers = readConfig(root).providers || {};
  } catch {}
  const attempts = result.attempts?.length
    ? result.attempts
    : [{
      executor: result.executor,
      model: result.model,
      ok: fallback.ok,
      duration_ms: result.duration_ms,
      tokens: fallback.tokens,
      reason: "initial",
    }];
  const tokenKeys = ["input", "output", "reasoning", "cache_read", "total"];
  const tokens = Object.fromEntries(tokenKeys.map((key) => [
    key,
    attempts.reduce((sum, attempt) => sum + (attempt.tokens?.[key] || 0), 0),
  ]));
  const costs = attempts.map((attempt) => estimateCost(attempt, catalog, providers));
  const totalCost = costs.every((cost) => cost != null)
    ? costs.reduce((sum, cost) => sum + cost, 0)
    : null;
  const outcome = result.ok ? "succeeded" : "failed";
  const final = attempts.at(-1);
  console.error(`alter ${id}: ${outcome} · ${attempts.length} attempt${attempts.length === 1 ? "" : "s"} · ${duration(result.duration_ms)}`);
  console.error(`final: ${final.executor || "unknown"} · ${final.model || "unknown"}`);
  console.error(`tokens: ${count(tokens.total)} total · tokens-in ${count(tokens.input)} · tokens-out ${count(tokens.output)} · ${count(tokens.reasoning)} reasoning · ${count(tokens.cache_read)} cached`);
  console.error(`estimated API-equivalent cost: ${formatCost(totalCost)} (configured/catalog rates; not a billing total)`);
  console.error("attempts:");
  attempts.forEach((attempt, index) => {
    const status = attempt.ok ? "ok" : attempt.killed ? "timeout" : "failed";
    console.error(
      `  ${index + 1}. ${attempt.executor || "unknown"} · ${attempt.model || "unknown"} · ${status} · ${duration(attempt.duration_ms)} · ` +
      `${count(attempt.tokens?.total)} tokens · ${formatCost(costs[index])}`,
    );
  });
  console.error(`home: ${result.home}`);
};

export const run = async (argv, ctx, { createOnly = false } = {}) => {
  const o = parseSpawnArgs(argv);
  if (!o.prompt) fail('spawn requires a prompt (positional or --prompt "...").');
  o.mindBinPath = ctx.cliEntry;
  const root = requireProjectRoot();
  const { home, created, result, res } = await spawnAlter(root, o, { createOnly });
  if (created) {
    console.log(home);
    console.error(`created (not run): ${path.relative(root, home)}`);
    return;
  }
  const out = res.text || "";
  process.stdout.write(out);
  if (out && !out.endsWith("\n")) process.stdout.write("\n");
  if (o.verbose) printExecutionSummary(o.id, result, res, root);
  // Without this the empty-output case is a bare exit 1 and no output at all,
  // which reads like a crash rather than "the model returned nothing".
  if (res.empty_output) {
    const n = result.attempts?.length ?? 1;
    console.error(
      `alter ${o.id}: returned no final message after ${n} attempt${n === 1 ? "" : "s"} ` +
      `(empty_output; model=${o.model}) — see ${result.home}/result.json`
    );
  } else if (!res.ok) {
    console.error(`alter ${o.id}: ${describeAlterFailure(result)} — see ${result.home}/result.json`);
  }
  if (!res.ok) process.exitCode = 1;
};
