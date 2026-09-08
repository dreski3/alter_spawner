import path from "node:path";
import { createOpinionReport, renderWorkflowReport } from "./opinion-report.js";
import { writeJsonAtomic, writeTextAtomic } from "./persistence.js";
import { fail } from "./util.js";

export const createFuseReport = ({ home, result, env, models = {} }) => {
  if (result?.id !== "fuse") fail("graph is not a fuse workflow.");
  const { opinions, totals, ...metadata } = createOpinionReport({ home, result, env });
  return {
    ...metadata,
    workflow: "fuse",
    status: result.ok ? result.state : "failed",
    totals: {
      nodes: opinions.length,
      analysts: opinions.filter((node) => node.id !== "writer").length,
      succeeded: totals.succeeded,
      tokens: totals.tokens,
      node_duration_ms: totals.reviewer_duration_ms,
      estimated_api_cost_usd: totals.estimated_api_cost_usd,
    },
    nodes: opinions.map((node) => ({
      ...node,
      model: node.model || models[node.id] || null,
      role: node.id === "writer" ? "writer" : "analyst",
    })),
  };
};

export const renderFuseReport = (report) => renderWorkflowReport({
  ...report,
  opinions: [...report.nodes.filter((node) => node.role === "writer"), ...report.nodes.filter((node) => node.role !== "writer")],
  totals: {
    ...report.totals,
    reviewers: report.totals.nodes,
    reviewer_duration_ms: report.totals.node_duration_ms,
  },
});

export const writeFuseReport = (home, result, options = {}) => {
  const report = createFuseReport({ home, result, ...options });
  const json = path.join(home, "fuse-report.json");
  const html = path.join(home, "fuse.html");
  writeJsonAtomic(json, report);
  writeTextAtomic(html, renderFuseReport(report));
  return { report, json, html };
};
