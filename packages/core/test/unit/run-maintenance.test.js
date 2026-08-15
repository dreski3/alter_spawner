import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCapabilityApprovalSession,
  createRunCapabilityRegistry,
  deleteRunCleanupCandidates,
  inspectRunCleanup,
} from "../../src/index.js";

const sandbox = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-run-maintenance-"));
  mkdirSync(path.join(root, ".alters", "runs"), { recursive: true });
  return root;
};

const addRun = (root, folder, result = null, bytes = 10) => {
  const home = path.join(root, ".alters", "runs", folder);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "alter.json"), JSON.stringify({ id: folder }));
  writeFileSync(path.join(home, "payload.txt"), "x".repeat(bytes));
  if (result) writeFileSync(path.join(home, "result.json"), JSON.stringify(result));
  return home;
};

test("cleanup inspection protects recent, incomplete, failed, graph, and newest runs", () => {
  const root = sandbox();
  const old = "20260101T000000Z_old";
  addRun(root, old, { id: "old", ok: true, ended_at: "2026-01-01T00:00:00.000Z", graph_id: null }, 25);
  addRun(root, "20260102T000000Z_failed", { ok: false, ended_at: "2026-01-02T00:00:00.000Z", graph_id: null });
  addRun(root, "20260103T000000Z_graph", { ok: true, ended_at: "2026-01-03T00:00:00.000Z", graph_id: "g1" });
  addRun(root, "20260104T000000Z_incomplete");
  addRun(root, "20260812T000000Z_recent", { ok: true, ended_at: "2026-08-12T00:00:00.000Z", graph_id: null });
  addRun(root, "20260813T000000Z_newest", { ok: true, ended_at: "2026-01-05T00:00:00.000Z", graph_id: null });

  const report = inspectRunCleanup(root, { olderThanDays: 30, keepNewest: 1, now: Date.UTC(2026, 7, 13) });
  assert.deepEqual(report.candidates.map((entry) => entry.folder), [old]);
  assert.ok(report.reclaimableBytes >= 25);
  assert.deepEqual(report.protected, { newest: 1, incomplete: 1, graph: 1, failed: 1, recent: 1, undated: 0 });
});

test("exact deletion revalidates run safety", () => {
  const root = sandbox();
  const removable = "20260101T000000Z_old";
  const incomplete = "20260102T000000Z_live";
  addRun(root, removable, { ok: true, ended_at: "2026-01-01T00:00:00.000Z", graph_id: null });
  addRun(root, incomplete);
  assert.throws(() => deleteRunCleanupCandidates(root, [incomplete]), /incomplete/);
  const result = deleteRunCleanupCandidates(root, [removable]);
  assert.deepEqual(result.removed, [removable]);
  assert.equal(existsSync(path.join(root, ".alters", "runs", removable)), false);
});

test("run deletion executes only after an allow-once approval", async () => {
  const root = sandbox();
  const folder = "20260101T000000Z_old";
  addRun(root, folder, { ok: true, ended_at: "2026-01-01T00:00:00.000Z", graph_id: null });
  const registry = createRunCapabilityRegistry({ root });
  let pending;
  const approvals = createCapabilityApprovalSession({
    registry,
    catalogId: "run-manager",
    onEvent: (event) => {
      if (event.type === "capability.approval_required") pending = event.approval;
    },
  });
  const execution = approvals.execute("runs.maintenance.delete", { input: { folders: [folder] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(path.join(root, ".alters", "runs", folder)), true);
  await approvals.decide(pending.id, "allow-once");
  assert.deepEqual((await execution).value.removed, [folder]);
});
