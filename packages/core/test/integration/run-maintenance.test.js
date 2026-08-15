import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCapabilityApprovalSession,
  createCapabilityExecutor,
  createRunCapabilityRegistry,
  registerHarness,
  runRunMaintenanceGraph,
} from "@mind/core";

let proposedPlan = { folders: [], reason: "Nothing worth deleting." };

registerHarness("run-maintenance-planner", {
  needsAgentHome: false,
  run: async () => ({
    tokens: { input: 10, output: 10, reasoning: 0, cache_read: 0, total: 20 },
    text: JSON.stringify(proposedPlan),
    sessionID: null,
    steps: 1,
    exitCode: 0,
    killed: false,
    ok: true,
    budget_exceeded: false,
    empty_output: false,
  }),
});

const fixture = (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-run-maintenance-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters", "catalog", "run-manager"), { recursive: true });
  mkdirSync(path.join(root, ".alters", "runs"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ default_model: "test/model" }));
  writeFileSync(path.join(root, ".alters", "catalog", "run-manager", "manifest.json"), JSON.stringify({
    name: "run-manager",
    description: "test run manager",
    max_tokens: 4000,
  }));
  const folder = "20260101T000000Z_old";
  const home = path.join(root, ".alters", "runs", folder);
  mkdirSync(home);
  writeFileSync(path.join(home, "alter.json"), JSON.stringify({ id: "old" }));
  writeFileSync(path.join(home, "result.json"), JSON.stringify({ id: "old", ok: true, ended_at: "2026-01-01T00:00:00.000Z", graph_id: null }));
  const runtime = { now: () => Date.parse("2026-08-13T00:00:00.000Z"), randomId: () => "1234567890123456", env: {} };
  const registry = createRunCapabilityRegistry({ root });
  const createSession = ({ catalogId, signal }) => {
    const session = createCapabilityApprovalSession({
      registry,
      catalogId,
      signal,
      onEvent: (event) => {
        if (event.type === "capability.approval_required") queueMicrotask(() => session.decide(event.approval.id, "allow-once"));
      },
    });
    return session;
  };
  registerHarness("capability", createCapabilityExecutor({ registry, createSession }));
  return { root, folder, home, runtime, registry };
};

test("a run-manager deletes only exact folders from its inspected inventory", async (t) => {
  const { root, folder, home, runtime, registry } = fixture(t);
  proposedPlan = { folders: [folder], reason: "Old completed standalone run." };
  const outcome = await runRunMaintenanceGraph(root, {
    approvals: { execute: (id, options) => registry.execute(id, options) },
    graph: { keepNewest: 0 },
    harness: "run-maintenance-planner",
    runtime,
  });
  assert.equal(outcome.committed, true);
  assert.equal(existsSync(home), false);
  assert.deepEqual(outcome.cleanup.removed, [folder]);
  assert.equal(JSON.parse(readFileSync(path.join(outcome.home, "maintenance.json"), "utf8")).committed, true);
});

test("a planner cannot smuggle in a folder that was not inspected", async (t) => {
  const { root, runtime, registry } = fixture(t);
  proposedPlan = { folders: ["20260102T000000Z_not-seen"], reason: "Try another folder." };
  await assert.rejects(runRunMaintenanceGraph(root, {
    approvals: { execute: (id, options) => registry.execute(id, options) },
    graph: { keepNewest: 0 },
    harness: "run-maintenance-planner",
    runtime,
  }), /outside the inspected candidates/);
});
