import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createOpinionReport } from "./opinion-report.js";
import { writeJsonAtomic, writeTextAtomic } from "./persistence.js";
import { fail } from "./util.js";

const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const money = (value) => value == null ? "—" : `$${value.toFixed(6)}`;
const tokenKeys = ["input", "output", "reasoning", "cache_read", "total"];

export const createCollaborateReport = ({ home, result, audit, env }) => {
  if (result?.id !== "collaborate") fail("graph is not a collaborate workflow.");
  const planners = createOpinionReport({ home, result, env });
  const execution = audit?.application?.execution;
  const taskTokens = execution?.tokens || {};
  const aggregateTokens = Object.fromEntries(tokenKeys.map((key) => [key, (result.tokens?.[key] || 0) + (taskTokens[key] || 0)]));
  const costs = [planners.totals.estimated_api_cost_usd, execution?.cost_usd];
  const estimatedCost = costs.some((value) => value == null) ? null : costs.reduce((sum, value) => sum + value, 0);
  return {
    schema_version: 1,
    workflow: "collaborate",
    graph_home: home,
    generated_at: new Date().toISOString(),
    status: audit?.status || "unknown",
    duration_ms: audit?.duration_ms ?? result.duration_ms ?? null,
    pricing: planners.pricing,
    totals: {
      planners: result.node_counts?.total || 0,
      tasks: audit?.selected_plan?.tasks?.length || 0,
      succeeded_tasks: execution?.node_counts?.succeeded || 0,
      tokens: aggregateTokens.total,
      estimated_api_cost_usd: estimatedCost,
    },
    aggregate_tokens: aggregateTokens,
    planner_nodes: planners.opinions,
    audit,
  };
};

export const renderCollaborateReport = (report) => {
  const audit = report.audit;
  const plan = audit?.selected_plan;
  const application = audit?.application;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collaborate · ${esc(report.status)}</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui;background:#090d14;color:#e7edf8}*{box-sizing:border-box}body{max-width:1200px;margin:auto;padding:32px;background:radial-gradient(circle at 10% 0,#27385f 0,transparent 30rem),#090d14}h1{font-size:clamp(2rem,5vw,3.4rem);margin:.2rem 0}.sub{color:#aab7ca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}.card,article{background:#121a28;border:1px solid #2b394f;border-radius:14px;padding:18px}.card b{display:block;font-size:1.15rem;margin-top:5px}.label{color:#91a2bd;text-transform:uppercase;font-size:.75rem;letter-spacing:.07em}.ok{color:#86efac}.bad{color:#fca5a5}code,pre{font-family:ui-monospace,monospace}li{margin:.7rem 0}footer{color:#8290a8;margin-top:24px;font-size:.8rem}</style></head><body>
  <p class="label">Alter Spawner · collaborate workflow</p><h1>Validated task collaboration</h1><p class="sub">Independent plans are schema-checked before any task executes. Writers share one isolated, serialized change boundary.</p>
  <section class="grid"><div class="card"><span class="label">Status</span><b>${esc(report.status)}</b></div><div class="card"><span class="label">Planners</span><b>${esc(report.totals.planners)}</b></div><div class="card"><span class="label">Tasks</span><b>${esc(report.totals.tasks)}</b></div><div class="card"><span class="label">Tokens</span><b>${esc(report.totals.tokens)}</b></div><div class="card"><span class="label">Estimated cost</span><b>${esc(money(report.totals.estimated_api_cost_usd))}</b></div></section>
  <article><span class="label">Selected plan</span><h2>${esc(plan?.summary || "No valid plan")}</h2>${plan ? `<ol>${plan.tasks.map((task) => `<li><code>${esc(task.id)}</code> · ${esc(task.role)} · ${esc(task.model)} · depends on ${esc(task.depends_on.join(", ") || "nothing")}<br>${esc(task.title)}</li>`).join("")}</ol>` : `<pre>${esc(audit?.candidates?.map((candidate) => candidate.error).filter(Boolean).join("\n") || "No candidate details")}</pre>`}</article>
  ${application ? `<article><span class="label">Application</span><p>${application.applied ? `<strong class="ok">Applied ${application.changedFiles.length} files</strong>` : `<strong class="bad">${esc(application.status)}</strong>`}</p>${application.error ? `<pre>${esc(application.error)}</pre>` : ""}</article>` : ""}
  <footer>Graph ${esc(report.graph_home)} · generated ${esc(report.generated_at)}</footer></body></html>`;
};

export const writeCollaborateReport = (home, result, options = {}) => {
  let audit = options.audit;
  const auditFile = path.join(home, "collaboration.json");
  if (audit === undefined && existsSync(auditFile)) audit = JSON.parse(readFileSync(auditFile, "utf8"));
  const report = createCollaborateReport({ home, result, ...options, audit });
  const json = path.join(home, "collaborate-report.json");
  const html = path.join(home, "collaborate.html");
  writeJsonAtomic(json, report);
  writeTextAtomic(html, renderCollaborateReport(report));
  return { report, json, html };
};
