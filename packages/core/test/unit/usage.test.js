// Usage answers two questions that behave differently, and most of what is asserted here
// is that the difference is respected. Spend is attributable to an interval — a run
// started at a time and cost what it cost — so a range query over it is meaningful.
// Storage is a level with no history on disk, so it is sampled and stamped rather than
// summed over a range.
//
// The rest of the file guards against over-counting, which is the failure mode that makes
// a usage number worse than no number at all: attempts vs. runs, graph node runs counted
// once, a tool call reported twice by the harness.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntime,
  folderTimestampMs,
  readSpendUsage,
  readStorageUsage,
  readUsage,
  resolveRange,
  summarizeRunFolder,
} from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);
const runtime = createRuntime({ now: () => FROZEN, env: {} });

const sandbox = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-usage-"));
  mkdirSync(path.join(root, ".alters", "runs"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ agent_id: "a1", name: "usage-test" }));
  return root;
};

const tokens = (total, extra = {}) => ({ input: total, output: 0, reasoning: 0, cache_read: 0, total, ...extra });

// A run home as the engine leaves it: a folder whose name carries the timestamp, an
// alter.json, and a result.json unless the run never finished.
const run = (root, folder, result) => {
  const home = path.join(root, ".alters", "runs", folder);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "alter.json"), JSON.stringify({ id: folder }));
  if (result) writeFileSync(path.join(home, "result.json"), JSON.stringify(result));
  return home;
};

test("spend sums tokens and tool calls over the runs in the range", () => {
  const root = sandbox();
  run(root, "20260806T100000Z_alpha", {
    ok: true,
    started_at: "2026-08-06T10:00:00.000Z",
    tokens: tokens(100),
    tools: { calls: 3, errors: 1, by_name: { read: 2, bash: 1 } },
    catalog: "curator",
    model: "m1",
    executor: "opencode",
  });
  run(root, "20260806T110000Z_beta", {
    ok: false,
    started_at: "2026-08-06T11:00:00.000Z",
    tokens: tokens(50),
    tools: { calls: 1, errors: 0, by_name: { read: 1 } },
    catalog: "curator",
    model: "m2",
    executor: "opencode",
  });
  // Outside the range on both sides.
  run(root, "20260805T100000Z_before", { ok: true, started_at: "2026-08-05T10:00:00.000Z", tokens: tokens(999) });
  run(root, "20260807T100000Z_after", { ok: true, started_at: "2026-08-07T10:00:00.000Z", tokens: tokens(999) });

  const spend = readSpendUsage(root, { from: "2026-08-06T00:00:00Z", to: "2026-08-06T23:59:59Z" });
  assert.equal(spend.runs, 2);
  assert.equal(spend.completed, 1);
  assert.equal(spend.failed, 1);
  assert.equal(spend.tokens.total, 150);
  assert.deepEqual(spend.tools, { calls: 4, errors: 1, by_name: { read: 3, bash: 1 } });
  assert.equal(spend.by_catalog.curator.runs, 2);
  assert.equal(spend.by_model.m1.tokens.total, 100);
  assert.equal(spend.first_run_at, "2026-08-06T10:00:00.000Z");
  assert.equal(spend.last_run_at, "2026-08-06T11:00:00.000Z");

  rmSync(root, { recursive: true, force: true });
});

test("an unbounded range covers every run", () => {
  const root = sandbox();
  run(root, "20260101T000000Z_old", { ok: true, started_at: "2026-01-01T00:00:00.000Z", tokens: tokens(7) });
  run(root, "20261231T000000Z_new", { ok: true, started_at: "2026-12-31T00:00:00.000Z", tokens: tokens(11) });

  assert.equal(readSpendUsage(root, {}).tokens.total, 18);
  // One-sided ranges are the common case in a UI ("since Monday").
  assert.equal(readSpendUsage(root, { from: "2026-06-01T00:00:00Z" }).tokens.total, 11);
  assert.equal(readSpendUsage(root, { to: "2026-06-01T00:00:00Z" }).tokens.total, 7);

  rmSync(root, { recursive: true, force: true });
});

test("attempts are the unit that spent tokens, not runs", () => {
  const root = sandbox();
  // A run that failed twice and succeeded on the third try paid three times, and
  // result.json only carries the last attempt's usage.
  run(root, "20260806T100000Z_retried", {
    ok: true,
    started_at: "2026-08-06T10:00:00.000Z",
    tokens: tokens(30),
    tools: { calls: 1, errors: 0, by_name: { read: 1 } },
    attempts: [
      { attempt: 1, tokens: tokens(10), tools: { calls: 2, errors: 2, by_name: { bash: 2 } } },
      { attempt: 2, tokens: tokens(20), tools: null },
      { attempt: 3, tokens: tokens(30), tools: { calls: 1, errors: 0, by_name: { read: 1 } } },
    ],
  });

  const spend = readSpendUsage(root, {});
  assert.equal(spend.tokens.total, 60);
  assert.deepEqual(spend.tools, { calls: 3, errors: 2, by_name: { bash: 2, read: 1 } });

  rmSync(root, { recursive: true, force: true });
});

test("a run with no result.json is counted as incomplete and its spend is not guessed", () => {
  const root = sandbox();
  run(root, "20260806T100000Z_inflight", null);

  const spend = readSpendUsage(root, {});
  assert.equal(spend.runs, 1);
  assert.equal(spend.incomplete, 1);
  assert.equal(spend.completed, 0);
  assert.equal(spend.tokens.total, 0);
  // Dated from the folder name, since there is no `started_at` to read.
  assert.equal(spend.first_run_at, "2026-08-06T10:00:00.000Z");

  rmSync(root, { recursive: true, force: true });
});

test("runs that predate tool accounting are reported as unknown, not as zero tool calls", () => {
  const root = sandbox();
  run(root, "20260806T100000Z_legacy", { ok: true, started_at: "2026-08-06T10:00:00.000Z", tokens: tokens(5) });
  run(root, "20260806T110000Z_modern", {
    ok: true,
    started_at: "2026-08-06T11:00:00.000Z",
    tokens: tokens(5),
    tools: { calls: 0, errors: 0, by_name: {} },
  });

  const spend = readSpendUsage(root, {});
  // Two runs, one of which cannot say anything about tools. "Nobody counted" and "counted
  // and found none" are different claims and only the first is reported here.
  assert.equal(spend.runs_without_tool_data, 1);
  assert.equal(spend.tools.calls, 0);

  rmSync(root, { recursive: true, force: true });
});

test("graph node runs are counted once, from runs/, not again from the graph document", () => {
  const root = sandbox();
  const nodeResult = {
    ok: true,
    started_at: "2026-08-06T10:00:00.000Z",
    tokens: tokens(40),
    catalog: null,
    model: "m1",
    executor: "llm",
  };
  run(root, "20260806T100000Z_synthesize", nodeResult);
  // The graph document embeds a copy of the same node result (graph.js), which is exactly
  // what would double the total if graphs/ were walked as well.
  const graphHome = path.join(root, ".alters", "graphs", "20260806T100000Z_pipeline");
  mkdirSync(graphHome, { recursive: true });
  writeFileSync(
    path.join(graphHome, "result.json"),
    JSON.stringify({ id: "pipeline", tokens: tokens(40), nodes: { synthesize: { result: nodeResult } } }),
  );

  assert.equal(readSpendUsage(root, {}).tokens.total, 40);

  rmSync(root, { recursive: true, force: true });
});

test("storage reports the whole project with memory broken out of the total", async () => {
  const root = sandbox();
  writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(100));
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "y".repeat(200));
  mkdirSync(path.join(root, ".alters", "memory"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "memory", "store.sqlite"), "m".repeat(500));
  run(root, "20260806T100000Z_alpha", { ok: true, started_at: "2026-08-06T10:00:00.000Z", tokens: tokens(1) });

  const storage = await readStorageUsage(root, { runtime });
  const summed = Object.values(storage.components).reduce((total, part) => total + part.bytes, 0);
  // The breakdown must account for the total exactly, or the widget's parts will not add
  // up to its headline.
  assert.equal(summed, storage.total_bytes);
  assert.equal(storage.memory_bytes, 500);
  // The packages and the project's own files are part of what the mind occupies.
  assert.ok(storage.components.other.bytes >= 300);
  assert.ok(storage.components.runs.bytes > 0);
  // A level, not a flow: it describes the instant it was taken.
  assert.equal(storage.sampled_at, new Date(FROZEN).toISOString());

  rmSync(root, { recursive: true, force: true });
});

test("a nested run home's own .alters counts as the parent's run history", async () => {
  const root = sandbox();
  // A nestable Alter's home is a project root for its children (scaffold.js). Those bytes
  // are the parent's run history, not a component of the parent's memory or catalog.
  const child = path.join(root, ".alters", "runs", "20260806T100000Z_parent", ".alters", "memory");
  mkdirSync(child, { recursive: true });
  writeFileSync(path.join(child, "store.sqlite"), "z".repeat(400));

  const storage = await readStorageUsage(root, { runtime });
  assert.equal(storage.components.runs.bytes, 400);
  assert.equal(storage.memory_bytes, 0);

  rmSync(root, { recursive: true, force: true });
});

test("readUsage can skip the expensive storage sample", async () => {
  const root = sandbox();
  run(root, "20260806T100000Z_alpha", { ok: true, started_at: "2026-08-06T10:00:00.000Z", tokens: tokens(3) });

  const cheap = await readUsage(root, { storage: false });
  assert.equal(cheap.storage, null);
  assert.equal(cheap.spend.tokens.total, 3);
  assert.deepEqual(cheap.range, { from: null, to: null });

  const full = await readUsage(root, { from: "2026-08-06T00:00:00Z", runtime });
  assert.equal(full.range.from, "2026-08-06T00:00:00.000Z");
  assert.ok(full.storage.total_bytes > 0);

  rmSync(root, { recursive: true, force: true });
});

test("ranges accept what a caller actually has, and reject what cannot be a range", () => {
  assert.deepEqual(resolveRange({}), { fromMs: null, toMs: null, from: null, to: null });
  assert.equal(resolveRange({ from: FROZEN }).from, "2026-08-06T12:00:00.000Z");
  assert.equal(resolveRange({ from: new Date(FROZEN) }).from, "2026-08-06T12:00:00.000Z");
  assert.equal(resolveRange({ from: "2026-08-06" }).from, "2026-08-06T00:00:00.000Z");
  assert.throws(() => resolveRange({ from: "last tuesday" }), /not a date/);
  assert.throws(() => resolveRange({ from: "2026-08-06", to: "2026-08-05" }), /ends before it begins/);
});

test("a run folder's timestamp is read from its name when its result cannot be", () => {
  assert.equal(folderTimestampMs("20260806T100000Z_alpha"), Date.UTC(2026, 7, 6, 10, 0, 0));
  assert.equal(folderTimestampMs("not-a-timestamp"), null);
});

test("a run whose date cannot be established anywhere is reported rather than dropped", () => {
  const root = sandbox();
  run(root, "undated_run", { ok: true, tokens: tokens(12) });

  const spend = readSpendUsage(root, {});
  assert.equal(spend.runs, 0);
  assert.equal(spend.undatable_runs, 1);
  assert.equal(spend.tokens.total, 0);

  rmSync(root, { recursive: true, force: true });
});

test("summarizing one run folder needs nothing but the folder", () => {
  const root = sandbox();
  const home = run(root, "20260806T100000Z_alpha", {
    ok: true,
    started_at: "2026-08-06T10:00:00.000Z",
    tokens: tokens(9),
    catalog: "curator",
  });

  const summary = summarizeRunFolder(home, "20260806T100000Z_alpha");
  assert.equal(summary.complete, true);
  assert.equal(summary.ok, true);
  assert.equal(summary.catalog, "curator");
  assert.equal(summary.tokens.total, 9);
  assert.equal(summary.tools, null);

  rmSync(root, { recursive: true, force: true });
});
