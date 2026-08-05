import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCapabilityApprovalSession,
  createCapabilityExecutor,
  createMemoryCapabilityRegistry,
  createProjectMemoryStore,
  registerHarness,
  runMemoryMaintenanceGraph,
} from "@mind/core";

let proposedPlan = [];

registerHarness("memory-maintenance-planner", {
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
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-memory-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters", "catalog", "memory-manager"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "test/model",
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  writeFileSync(path.join(root, ".alters", "catalog", "memory-manager", "manifest.json"), JSON.stringify({
    name: "memory-manager",
    description: "test memory manager",
    max_tokens: 8000,
    output_contract: { type: "json", trim: true },
  }));
  let nextId = 0;
  const runtime = {
    now: () => Date.parse("2026-08-05T10:00:00.000Z"),
    randomId: () => String(nextId += 1).padStart(16, "0"),
    env: {},
  };
  const store = createProjectMemoryStore(root, { projectId: "naut", runtime });
  const registry = createMemoryCapabilityRegistry({ store });
  const createSession = ({ catalogId, signal, onEvent }) => {
    const session = createCapabilityApprovalSession({
      registry,
      catalogId,
      signal,
      onEvent: (event) => {
        onEvent?.(event);
        if (event.type === "capability.approval_required") {
          queueMicrotask(() => session.decide(event.approval.id, "allow-once"));
        }
      },
    });
    return session;
  };
  registerHarness("capability", createCapabilityExecutor({ registry, createSession }));
  return { root, runtime, store, registry };
};

test("an empty maintenance plan stays completely non-mutating", async (t) => {
  const { root, runtime, store } = fixture(t);
  const scope = { project: "naut", namespace: "architecture" };
  await store.put({ content: "A durable architecture decision." }, scope);
  proposedPlan = [];
  let commitCalls = 0;
  const outcome = await runMemoryMaintenanceGraph(root, {
    scope,
    approvals: { execute: async () => { commitCalls += 1; throw new Error("must not execute"); } },
    harness: "memory-maintenance-planner",
    runtime,
  });
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.committed, false);
  assert.equal(commitCalls, 0);
  assert.equal(existsSync(path.join(outcome.home, "maintenance.json")), true);
});

test("a maintenance graph commits one exact approved atomic plan", async (t) => {
  const { root, runtime, store, registry } = fixture(t);
  const scope = { project: "naut", namespace: "architecture" };
  const original = await store.put({ content: "Prefer the JSON backend.", kind: "decision" }, scope);
  proposedPlan = [{
    operation: "update",
    id: original.id,
    expectedVersion: 1,
    patch: { content: "Prefer an indexed memory backend." },
  }];
  let commitCalls = 0;
  const approvals = {
    execute: async (capabilityId, options) => {
      commitCalls += 1;
      assert.equal(capabilityId, "memory.records.maintain");
      return registry.execute(capabilityId, options);
    },
  };
  const outcome = await runMemoryMaintenanceGraph(root, {
    scope,
    approvals,
    harness: "memory-maintenance-planner",
    runtime,
  });
  assert.equal(outcome.committed, true);
  assert.equal(commitCalls, 1);
  assert.equal((await store.get(original.id, scope)).content, "Prefer an indexed memory backend.");
  const trace = JSON.parse(readFileSync(path.join(outcome.home, "maintenance.json"), "utf8"));
  assert.equal(trace.operations[0].expectedVersion, 1);
  assert.equal(trace.records[0].version, 2);
});

test("delete plans are rejected before approval unless explicitly enabled", async (t) => {
  const { root, runtime, store } = fixture(t);
  const scope = { project: "naut" };
  const original = await store.put({ content: "Keep this record." }, scope);
  proposedPlan = [{ operation: "delete", id: original.id, expectedVersion: 1 }];
  let commitCalls = 0;
  await assert.rejects(
    runMemoryMaintenanceGraph(root, {
      scope,
      approvals: { execute: async () => { commitCalls += 1; } },
      harness: "memory-maintenance-planner",
      runtime,
    }),
    /deletion is disabled/,
  );
  assert.equal(commitCalls, 0);
  assert.ok(await store.get(original.id, scope));
});
