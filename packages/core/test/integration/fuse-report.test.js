import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFuseReport, renderFuseReport, writeFuseReport } from "@mind/core";
import { graphHomeForReport } from "../../../cli/src/commands/work.js";

const node = (id, text) => ({ id, state: "succeeded", result: {
  model: "test/model", text, executor: "llm", duration_ms: 1250,
  tokens: { input: 1000, output: 50, reasoning: 10, cache_read: 25, total: 1085 },
} });
const result = { id: "fuse", ok: true, state: "completed", nodes: {
  analyst_1: node("analyst_1", "<script>alert('unsafe')</script>"),
  analyst_2: node("analyst_2", "Alternative design"),
  writer: node("writer", "Recommended implementation"),
} };

test("fuse HTML puts synthesis first, collapses analysts, and safely renders usage", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "fuse-report-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const files = writeFuseReport(home, result, { env: { OPENCODE_MODELS_PATH: path.join(home, "missing.json") } });
  const html = readFileSync(files.html, "utf8");
  assert.match(html, /Implementation synthesis/);
  assert.ok(html.indexOf("Recommended implementation") < html.indexOf("Alternative design"));
  assert.equal((html.match(/<details class="response">/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|NaN|https?:\/\//);
  assert.match(html, /width:100%/);
  assert.match(html, /1,000 \/ 50/);
  assert.match(html, /10 \/ 25/);
  assert.match(html, /fuse-report.json/);
  assert.equal(files.report.totals.estimated_api_cost_usd, null);
  assert.equal(JSON.parse(readFileSync(files.json)).nodes[2].role, "writer");
});

test("failed fuse reports never present failed writer text as successful synthesis", () => {
  const failed = { ...result, ok: false, nodes: { ...result.nodes, writer: { ...node("writer", "Unvalidated draft"), state: "failed", error: "Budget exceeded" } } };
  const report = createFuseReport({ home: "/tmp/fuse", result: failed });
  assert.equal(report.status, "failed");
  assert.match(renderFuseReport(report), /Budget exceeded/);
  assert.doesNotMatch(renderFuseReport(report), /Unvalidated draft/);
  assert.throws(() => createFuseReport({ home: "/tmp/fuse", result: { ...result, id: "opinion" } }), /not a fuse/);
});

test("report selection finds the latest matching workflow and rejects outside paths", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fuse-selection-"));
  const outside = mkdtempSync(path.join(tmpdir(), "fuse-outside-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const graphs = path.join(root, ".alters/graphs");
  for (const [name, id] of [["001_fuse", "fuse"], ["002_opinion", "opinion"]]) {
    mkdirSync(path.join(graphs, name), { recursive: true });
    writeFileSync(path.join(graphs, name, "result.json"), JSON.stringify({ ...result, id }));
  }
  assert.equal(graphHomeForReport(root, undefined, "fuse").result.id, "fuse");
  assert.equal(graphHomeForReport(root, undefined, "opinion").result.id, "opinion");
  assert.throws(() => graphHomeForReport(root, "002_opinion", "fuse"), /not a fuse/);
  writeFileSync(path.join(outside, "result.json"), JSON.stringify(result));
  symlinkSync(outside, path.join(graphs, "outside"));
  assert.throws(() => graphHomeForReport(root, "outside", "fuse"), /must be inside/);
});
