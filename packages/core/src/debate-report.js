import path from "node:path";
import { createOpinionReport, renderWorkflowReport } from "./opinion-report.js";
import { writeJsonAtomic, writeTextAtomic } from "./persistence.js";
import { fail } from "./util.js";

const identity = (id) => {
  const opening = id.match(/^opening_(\d+)$/);
  if (opening) return { round: 0, reviewer: Number(opening[1]), phase: "opening" };
  const critique = id.match(/^critique_(\d+)_(\d+)$/);
  if (critique) return { round: Number(critique[1]), reviewer: Number(critique[2]), phase: "critique" };
  return { round: null, reviewer: null, phase: "unknown" };
};

export const createDebateReport = ({ home, result, env }) => {
  if (result?.id !== "debate") fail("graph is not a debate workflow.");
  const { opinions, totals, ...metadata } = createOpinionReport({ home, result, env });
  const nodes = opinions.map((node) => ({ ...node, ...identity(node.id) }));
  const critiqueRounds = Math.max(0, ...nodes.map((node) => node.round || 0));
  return {
    ...metadata,
    workflow: "debate",
    status: result.ok ? result.state : "failed",
    critique_rounds: critiqueRounds,
    totals: {
      nodes: nodes.length,
      reviewers: new Set(nodes.map((node) => node.reviewer).filter(Boolean)).size,
      succeeded: totals.succeeded,
      tokens: totals.tokens,
      node_duration_ms: totals.reviewer_duration_ms,
      estimated_api_cost_usd: totals.estimated_api_cost_usd,
    },
    nodes,
  };
};

export const renderDebateReport = (report) => renderWorkflowReport({
  ...report,
  opinions: report.nodes,
  totals: {
    ...report.totals,
    reviewers: report.totals.nodes,
    reviewer_duration_ms: report.totals.node_duration_ms,
  },
});

export const writeDebateReport = (home, result, options = {}) => {
  const report = createDebateReport({ home, result, ...options });
  const json = path.join(home, "debate-report.json");
  const html = path.join(home, "debate.html");
  writeJsonAtomic(json, report);
  writeTextAtomic(html, renderDebateReport(report));
  return { report, json, html };
};
