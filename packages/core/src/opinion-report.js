import { renderReportMarkdown } from "./report-markdown.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { modelsCatalogPath, splitModelRef } from "./providers.js";
import { writeJsonAtomic, writeTextAtomic } from "./persistence.js";

const TOKEN_KEYS = ["input", "output", "reasoning", "cache_read", "total"];
const MILLION = 1_000_000;

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value || 0);
const formatUsd = (value) => value == null ? "—" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6,
}).format(value);
const formatDuration = (ms) => {
  if (ms == null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
};

const sumUsages = (attempts, fallback = {}) => {
  const usages = attempts?.length ? attempts.map((attempt) => attempt.tokens) : [fallback];
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, usages.reduce((sum, usage) => sum + (usage?.[key] || 0), 0)]));
};

const catalogPricing = (model, catalog) => {
  try {
    const { providerId, modelId } = splitModelRef(model);
    const cost = catalog?.[providerId]?.models?.[modelId]?.cost;
    if (!cost || ![cost.input, cost.output, cost.cache_read].some((rate) => typeof rate === "number")) return null;
    return {
      input: typeof cost.input === "number" ? cost.input : null,
      output: typeof cost.output === "number" ? cost.output : null,
      cache_read: typeof cost.cache_read === "number" ? cost.cache_read : null,
    };
  } catch {
    return null;
  }
};

const estimateCost = (tokens, rates) => {
  if (!rates) return null;
  const priced = ["input", "output", "cache_read"].filter((key) => rates[key] != null);
  if (!priced.length) return null;
  return priced.reduce((total, key) => total + ((tokens[key] || 0) * rates[key] / MILLION), 0);
};

const readCatalog = (env) => {
  const file = modelsCatalogPath(env);
  if (!existsSync(file)) return { catalog: null, source: null };
  try {
    return { catalog: JSON.parse(readFileSync(file, "utf8")), source: file };
  } catch {
    return { catalog: null, source: null };
  }
};

export const createOpinionReport = ({ home, result, env = process.env }) => {
  const { catalog, source } = readCatalog(env);
  const opinions = Object.values(result?.nodes || {}).map((node) => {
    const run = node.result || {};
    const model = run.model || null;
    const tokens = sumUsages(run.attempts, run.tokens);
    const rates = model ? catalogPricing(model, catalog) : null;
    return {
      id: node.id,
      model,
      state: node.state,
      text: run.text || null,
      error: node.error || run.llm_error || null,
      executor: run.executor || null,
      attempts: run.attempts?.length || 0,
      max_tokens: run.max_tokens ?? null,
      started_at: run.started_at || null,
      ended_at: run.ended_at || null,
      duration_ms: run.duration_ms ?? null,
      tokens,
      pricing: rates ? { source: "opencode-model-catalog", rates_usd_per_million: rates } : null,
      estimated_api_cost_usd: estimateCost(tokens, rates),
    };
  });
  const estimatedCosts = opinions.map((opinion) => opinion.estimated_api_cost_usd).filter((cost) => cost != null);
  return {
    schema_version: 1,
    workflow: "opinion",
    graph_home: home,
    graph_id: result?.id || "opinion",
    generated_at: new Date().toISOString(),
    started_at: result?.started_at || null,
    ended_at: result?.ended_at || null,
    duration_ms: result?.duration_ms ?? null,
    status: result?.state || null,
    pricing: {
      source: source ? "opencode-model-catalog" : "unavailable",
      catalog_path: source,
      unit: "USD per million tokens",
      note: "Estimated API-equivalent spend from the local catalog. Subscription, OAuth, bundled, and promotional billing can differ from this estimate.",
    },
    totals: {
      reviewers: opinions.length,
      succeeded: opinions.filter((opinion) => opinion.state === "succeeded").length,
      tokens: opinions.reduce((sum, opinion) => sum + opinion.tokens.total, 0),
      reviewer_duration_ms: opinions.reduce((sum, opinion) => sum + (opinion.duration_ms || 0), 0),
      estimated_api_cost_usd: estimatedCosts.length === opinions.length
        ? estimatedCosts.reduce((sum, cost) => sum + cost, 0)
        : null,
    },
    opinions,
  };
};

const metric = (label, value) => `<div class="metric"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

const bar = (value, maximum, label, accent, display = value) => {
  const width = maximum > 0 ? Math.max(2, Math.round((value / maximum) * 100)) : 0;
  return `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar"><i style="width:${width}%;--accent:${accent}"></i></div><b>${escapeHtml(display)}</b></div>`;
};

export const renderWorkflowReport = (report) => {
  const fuse = report.workflow === "fuse";
  const debate = report.workflow === "debate";
  const title = fuse ? "Implementation synthesis" : debate ? "Debate rounds" : "Opinion comparison";
  const maxTokens = Math.max(0, ...report.opinions.map((opinion) => opinion.tokens.total));
  const maxDuration = Math.max(0, ...report.opinions.map((opinion) => opinion.duration_ms || 0));
  const maxCost = Math.max(0, ...report.opinions.map((opinion) => opinion.estimated_api_cost_usd || 0));
  const card = (opinion, index) => {
    const accent = ["#7c3aed", "#0891b2", "#d97706", "#be123c", "#4f46e5"][index % 5];
    const rates = opinion.pricing?.rates_usd_per_million;
    const rateText = rates
      ? `in ${rates.input ?? "—"} · out ${rates.output ?? "—"} · cache ${rates.cache_read ?? "—"}`
      : "unavailable";
    const status = opinion.state === "succeeded" ? "complete" : opinion.state;
    const writer = fuse && opinion.id === "writer";
    const label = fuse
      ? (writer ? "Writer · synthesis" : opinion.id.replace("analyst_", "Analyst "))
      : debate ? `Reviewer ${opinion.reviewer}` : `Reviewer ${index + 1}`;
    const output = renderReportMarkdown(opinion.state === "succeeded" ? (opinion.text || "No response recorded.") : (opinion.error || "No successful response recorded."));
    return `<article class="opinion${writer ? " synthesis" : ""}" style="--accent:${accent}">
      <header><span class="ordinal">${escapeHtml(label)}</span><span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span><h2>${escapeHtml(opinion.model || "Unknown model")}</h2></header>
      <dl class="metrics">
        ${metric("Estimated API cost", formatUsd(opinion.estimated_api_cost_usd))}
        ${metric("Elapsed", formatDuration(opinion.duration_ms))}
        ${metric("Total tokens", formatNumber(opinion.tokens.total))}
        ${metric("Attempts", opinion.attempts || "—")}
      </dl>
      <section class="details"><dl>
        <div><dt>Executor</dt><dd>${escapeHtml(opinion.executor || "—")}</dd></div>
        <div><dt>Budget</dt><dd>${escapeHtml(opinion.max_tokens == null ? "—" : `${formatNumber(opinion.max_tokens)} tokens`)}</dd></div>
        <div><dt>Input / output</dt><dd>${formatNumber(opinion.tokens.input)} / ${formatNumber(opinion.tokens.output)}</dd></div>
        <div><dt>Reasoning / cache read</dt><dd>${formatNumber(opinion.tokens.reasoning)} / ${formatNumber(opinion.tokens.cache_read)}</dd></div>
        <div><dt>Rates (USD / M tokens)</dt><dd>${escapeHtml(rateText)}</dd></div>
      </dl></section>
      <section class="comparison">
        ${bar(opinion.tokens.total, maxTokens, "Tokens", accent, formatNumber(opinion.tokens.total))}
        ${bar(opinion.duration_ms || 0, maxDuration, "Time", accent, formatDuration(opinion.duration_ms))}
        ${bar(opinion.estimated_api_cost_usd || 0, maxCost, "Cost", accent, formatUsd(opinion.estimated_api_cost_usd))}
      </section>
      ${fuse && !writer ? `<details class="response"><summary>Analyst output</summary><div class="markdown">${output}</div></details>` : `<section class="response"><h3>${writer ? "Synthesized implementation answer" : debate ? (opinion.phase === "opening" ? "Opening position" : "Critique and revision") : "Opinion"}</h3><div class="markdown">${output}</div></section>`}
    </article>`;
  };
  const cards = debate
    ? [...new Set(report.opinions.map((opinion) => opinion.round))].sort((a, b) => a - b).map((round) => {
      const entries = report.opinions.filter((opinion) => opinion.round === round);
      const heading = round === 0 ? "Opening positions" : `Critique round ${round}`;
      return `<section class="round"><h2 class="round-title">${heading}</h2><div class="grid">${entries.map((opinion) => card(opinion, opinion.reviewer - 1)).join("\n")}</div></section>`;
    }).join("\n")
    : `<main class="grid">${report.opinions.map(card).join("\n")}</main>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${escapeHtml(report.graph_id)}</title>
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background:#0a0d14; color:#e8ecf5; }
  * { box-sizing:border-box; } body { max-width:1700px; margin:0 auto; padding:32px; background:radial-gradient(circle at 15% 0,#1d1741 0,transparent 32rem),#0a0d14; }
  h1,h2,h3,p { margin:0; } .eyebrow { color:#aeb9d3; font-size:.8rem; letter-spacing:.08em; text-transform:uppercase; } h1 { font-size:clamp(2rem,4vw,3.4rem); margin:6px 0 10px; } .subtitle { color:#bac4d8; max-width:900px; line-height:1.5; }
  .summary { display:grid; grid-template-columns:repeat(5,minmax(130px,1fr)); gap:10px; margin:24px 0; } .summary div,.opinion { background:#121827dd; border:1px solid #263148; border-radius:14px; } .summary div { padding:14px; } dt { color:#95a3c2; font-size:.76rem; text-transform:uppercase; letter-spacing:.06em; } dd { margin:5px 0 0; font-weight:650; }
  .notice { margin:0 0 24px; padding:12px 14px; border-radius:10px; color:#cbd5e1; border:1px solid #334155; background:#0f172a99; font-size:.88rem; line-height:1.45; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr)); gap:16px; align-items:start; } .opinion { overflow:hidden; border-top:3px solid var(--accent); } .opinion header { padding:20px 20px 12px; } .ordinal { color:#9aa9ca; font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; } h2 { margin-top:6px; font-size:1.2rem; overflow-wrap:anywhere; } .status { float:right; padding:4px 8px; border-radius:999px; font-size:.75rem; background:#334155; } .status.complete { background:#14532d; color:#bbf7d0; }
  .metrics { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:#263148; border-block:1px solid #263148; } .metric { padding:12px 20px; background:#121827; } .metric dd { font-size:1.08rem; }
  .details { padding:16px 20px 4px; } .details dl { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:0; } .details dd { overflow-wrap:anywhere; font-size:.88rem; }
  .comparison { padding:16px 20px; border-bottom:1px solid #263148; } .bar-row { display:grid; grid-template-columns:75px 1fr auto; align-items:center; gap:8px; margin:8px 0; font-size:.78rem; color:#aab6ce; } .bar-row b { color:#e8ecf5; font-weight:600; } .bar { overflow:hidden; height:7px; background:#263148; border-radius:99px; } .bar i { display:block; height:100%; border-radius:99px; background:var(--accent); }
  .response { padding:20px; } h3 { color:#aeb9d3; font-size:.78rem; text-transform:uppercase; letter-spacing:.08em; margin-bottom:9px; } pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font: .88rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; color:#e4e8f3; }
  .markdown { font-size:.95rem; line-height:1.65; overflow-wrap:anywhere; }
  .markdown > :first-child { margin-top:0; } .markdown > :last-child { margin-bottom:0; }
  .markdown p,.markdown ul,.markdown ol,.markdown blockquote,.markdown pre,.markdown table { margin:0 0 1rem; }
  .markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6 { color:#e8ecf5; text-transform:none; letter-spacing:normal; margin:1.4rem 0 .6rem; line-height:1.3; }
  .markdown h1 { font-size:1.65rem; } .markdown h2 { font-size:1.35rem; } .markdown h3 { font-size:1.12rem; }
  .markdown ul,.markdown ol { padding-left:1.6rem; } .markdown li { margin:.25rem 0; } .markdown li > ul,.markdown li > ol { margin-bottom:.4rem; }
  .markdown a { color:#93c5fd; text-decoration:underline; }
  .markdown code { font:.88em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0a101e; border-radius:4px; padding:.15em .35em; }
  .markdown pre { padding:16px; background:#080e19; border:1px solid #263148; border-radius:8px; overflow:auto; white-space:pre; }
  .markdown pre code { padding:0; background:none; }
  .markdown blockquote { border-left:3px solid #64748b; padding:.2rem 1rem; color:#b8c5de; }
  .markdown table { display:block; width:100%; overflow:auto; border-collapse:collapse; font-size:.88rem; }
  .markdown th,.markdown td { border:1px solid #334155; padding:8px 12px; text-align:left; }
  .markdown th { background:#1d2940; } .markdown hr { border:0; border-top:1px solid #334155; margin:1.4rem 0; }
  .synthesis { grid-column:1 / -1; } summary { cursor:pointer; color:#aeb9d3; margin-bottom:12px; } .grid > * { min-width:0; }
  .round { margin-top:28px; } .round-title { margin:0 0 12px; font-size:1.35rem; }
  footer { color:#8190ae; margin-top:24px; font-size:.78rem; } @media (max-width:700px) { body { padding:18px; } .summary { grid-template-columns:1fr 1fr; } .details dl { grid-template-columns:1fr; } }
</style></head><body>
<p class="eyebrow">Alter Spawner · ${escapeHtml(report.workflow)} workflow · ${escapeHtml(report.status)}</p><h1>${title}</h1>
<p class="subtitle">${fuse ? "Independent analysts → one selected writer. The synthesis appears first; expand each analyst output to inspect its evidence." : debate ? "Independent opening positions followed by bounded critique rounds. No winner or synthesis is selected." : "Parallel reviewer outputs arranged side-by-side with the execution and usage evidence needed to compare them."}</p>
<section class="summary">
  <div><dt>${fuse || debate ? "Nodes" : "Reviewers"}</dt><dd>${report.totals.succeeded} / ${report.totals.reviewers} complete</dd></div>
  <div><dt>Wall-clock time</dt><dd>${formatDuration(report.duration_ms)}</dd></div>
  <div><dt>${fuse || debate ? "Total node time" : "Reviewer time"}</dt><dd>${formatDuration(report.totals.reviewer_duration_ms)}</dd></div>
  <div><dt>Total tokens</dt><dd>${formatNumber(report.totals.tokens)}</dd></div>
  <div><dt>Estimated API cost</dt><dd>${formatUsd(report.totals.estimated_api_cost_usd)}</dd></div>
</section>
<p class="notice">${escapeHtml(report.pricing.note)} Rates are read when this dashboard is generated (${escapeHtml(report.pricing.catalog_path || "no catalog available")}); retain <code>${escapeHtml(report.workflow)}-report.json</code> with this HTML to preserve the rate snapshot.</p>
${cards}
<footer>Graph ${escapeHtml(report.graph_id)} · started ${escapeHtml(report.started_at || "—")} · dashboard generated ${escapeHtml(report.generated_at)}</footer>
</body></html>`;
};

export const renderOpinionReport = (report) => renderWorkflowReport(report);

export const writeOpinionReport = (home, result, options = {}) => {
  const report = createOpinionReport({ home, result, ...options });
  writeJsonAtomic(path.join(home, "opinion-report.json"), report);
  writeTextAtomic(path.join(home, "opinion.html"), renderOpinionReport(report));
  return { report, html: path.join(home, "opinion.html"), json: path.join(home, "opinion-report.json") };
};
