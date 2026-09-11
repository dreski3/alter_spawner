import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createOpinionReport } from "./opinion-report.js";
import { writeJsonAtomic, writeTextAtomic } from "./persistence.js";
import { fail } from "./util.js";

const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const money = (value) => value == null ? "—" : `$${value.toFixed(6)}`;

export const createValidateReport = ({ home, result, env, model, audit }) => {
  if (result?.id !== "validate") fail("graph is not a validate workflow.");
  const base = createOpinionReport({ home, result, env });
  const designer = { ...base.opinions[0], model: base.opinions[0]?.model || model || null };
  const attempts = audit?.application?.attempts || [];
  const tokenKeys = ["input", "output", "reasoning", "cache_read", "total"];
  const aggregateTokens = Object.fromEntries(tokenKeys.map((key) => [
    key,
    (designer.tokens?.[key] || 0) + attempts.reduce((sum, attempt) => sum + (attempt.tokens?.[key] || 0), 0),
  ]));
  const nodeDuration = (designer.duration_ms || 0) + attempts.reduce((sum, attempt) => sum + (attempt.duration_ms || 0), 0);
  const estimatedCost = audit?.application ? audit.application.totalCost : base.totals.estimated_api_cost_usd;
  return {
    schema_version: 1,
    workflow: "validate",
    graph_home: home,
    graph_id: result.id,
    generated_at: new Date().toISOString(),
    status: audit?.status || (result.ok ? "awaiting_contract_validation" : "designer_failed"),
    started_at: result.started_at || null,
    ended_at: result.ended_at || null,
    duration_ms: audit?.duration_ms ?? result.duration_ms ?? null,
    pricing: base.pricing,
    totals: { nodes: 1 + attempts.length, succeeded: base.totals.succeeded + attempts.filter((attempt) => attempt.ok).length, tokens: aggregateTokens.total, node_duration_ms: nodeDuration, estimated_api_cost_usd: estimatedCost },
    aggregate_tokens: aggregateTokens,
    designer,
    audit,
  };
};

export const renderValidateReport = (report) => {
  const audit = report.audit;
  const contract = audit?.contract;
  const commands = contract?.commands || [];
  const gate = audit?.gate || [];
  const application = audit?.application;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Validation gate · ${esc(report.graph_id)}</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui;background:#090d14;color:#e7edf8}*{box-sizing:border-box}body{max-width:1200px;margin:auto;padding:32px;background:radial-gradient(circle at 10% 0,#13352f 0,transparent 30rem),#090d14}h1{font-size:clamp(2rem,5vw,3.4rem);margin:.2rem 0}.sub{color:#aab7ca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0}.card,article{background:#121a28;border:1px solid #2b394f;border-radius:14px;padding:18px}.card b{display:block;font-size:1.15rem;margin-top:5px}.label{color:#91a2bd;text-transform:uppercase;font-size:.75rem;letter-spacing:.07em}.ok{color:#86efac}.bad{color:#fca5a5}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a101b;padding:14px;border-radius:9px}li{margin:.6rem 0}footer{color:#8290a8;margin-top:24px;font-size:.8rem}</style></head><body>
  <p class="label">Alter Spawner · validate workflow</p><h1>Frozen acceptance gate</h1><p class="sub">Designer guidance is accepted only after deterministic schema, command, path, timeout, and cost checks.</p>
  <section class="grid"><div class="card"><span class="label">Status</span><b>${esc(report.status)}</b></div><div class="card"><span class="label">Tokens</span><b>${esc(report.totals.tokens)}</b></div><div class="card"><span class="label">Estimated cost</span><b>${esc(money(report.totals.estimated_api_cost_usd))}</b></div><div class="card"><span class="label">Gate</span><b>${gate.filter((entry) => entry.ok).length}/${commands.length} passed</b></div>${application ? `<div class="card"><span class="label">Baseline</span><b>${application.baselineGate.filter((entry) => entry.ok).length}/${commands.length} passed</b></div><div class="card"><span class="label">Apply</span><b>${application.applied ? `${application.changedFiles.length} files` : "No changes"}</b></div><div class="card"><span class="label">Implementer attempts</span><b>${application.attempts.length}</b></div>` : ""}</section>
  <article><span class="label">Contract</span><h2>${esc(contract?.summary || audit?.contract_error || "No validated contract")}</h2>${commands.length ? `<ol>${commands.map((command, index) => `<li><code>${esc(JSON.stringify(command.argv))}</code> — ${esc(command.purpose)}<br><span class="${gate[index]?.ok ? "ok" : gate[index] ? "bad" : "sub"}">${gate[index] ? (gate[index].ok ? "passed" : `failed (exit ${gate[index].exit_code ?? "—"})`) : "not run"}</span></li>`).join("")}</ol>` : ""}</article>
  ${gate.map((entry, index) => `<article><span class="label">Command ${index + 1} output</span><pre>${esc(entry.stdout || entry.stderr || entry.error || "(no output)")}</pre></article>`).join("")}
  ${application?.attempts?.length ? `<article><span class="label">Implementer attempts</span><ol>${application.attempts.map((attempt) => `<li>Attempt ${attempt.attempt}: <strong class="${attempt.ok ? "ok" : "bad"}">${esc(attempt.state)}</strong> · ${esc(attempt.tokens?.total || 0)} tokens · ${esc(attempt.changed_files?.length || 0)} changed files<br>${esc(attempt.summary || attempt.error || "No summary")}</li>`).join("")}</ol></article>` : ""}
  ${application?.error ? `<article><span class="label">Apply rejection</span><pre>${esc(application.error)}</pre></article>` : ""}
  <footer>Graph ${esc(report.graph_home)} · generated ${esc(report.generated_at)} · retain validate-report.json and validation.json with this dashboard.</footer></body></html>`;
};

export const writeValidateReport = (home, result, options = {}) => {
  let audit = options.audit;
  const auditFile = path.join(home, "validation.json");
  if (audit === undefined && existsSync(auditFile)) audit = JSON.parse(readFileSync(auditFile, "utf8"));
  const report = createValidateReport({ home, result, ...options, audit });
  const json = path.join(home, "validate-report.json");
  const html = path.join(home, "validate.html");
  writeJsonAtomic(json, report);
  writeTextAtomic(html, renderValidateReport(report));
  return { report, json, html };
};
