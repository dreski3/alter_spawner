import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHarness, runCollaborate } from "@mind/core";

const response = (text) => ({ text, tokens: { input: 2, output: 3, reasoning: 0, cache_read: 0, total: 5 }, sessionID: null, steps: 1, exitCode: 0, killed: false, ok: true, budget_exceeded: false, empty_output: false });
const plan = JSON.stringify({
  summary: "Review the behavior and implement the fix.",
  tasks: [
    { id: "review", title: "Review behavior", role: "reader", model: "test/worker", depends_on: [], instructions: "Explain the required correction.", allowed_paths: [], expected_output: "A correction note.", max_tokens: 1000 },
    { id: "implement", title: "Implement correction", role: "writer", model: "test/worker", depends_on: ["review"], instructions: "Make source ready.", allowed_paths: ["source.js"], expected_output: "A change summary.", max_tokens: 2000 },
  ],
});

const fixture = (t, git = false) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-collaborate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({ default_model: "test/default", retry: { same_harness_retries: 0, fallback_retries: 0 } }));
  writeFileSync(path.join(root, "source.js"), "export const ready = false;\n");
  if (git) {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["add", "source.js"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd: root }).status, 0);
  }
  return root;
};

const commandResult = (argv, ok) => ({ argv, exit_code: ok ? 0 : 1, signal: null, timed_out: false, aborted: false, error: null, duration_ms: 1, stdout: ok ? "passed" : "", stderr: ok ? "" : "not ready", stdout_truncated: false, stderr_truncated: false });

test("collaborate dry-run selects a valid plan without invoking workers", async (t) => {
  const root = fixture(t);
  registerHarness("collaborate-dry-planners", { async run() { return response(plan); } });
  let workerCalled = false;
  const outcome = await runCollaborate(root, { task: "Fix source", planners: ["test/p1", "test/p2"], workers: ["test/worker"], writePaths: ["source.js"], commands: [["npm", "test"]], dryRun: true }, { plannerHarness: "collaborate-dry-planners", workerHarness: { async run() { workerCalled = true; } } });
  assert.equal(outcome.status, "plan_ready");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.audit.selected_plan.tasks.length, 2);
  assert.equal(workerCalled, false);
});

test("collaborate rejects malformed planner output without invoking workers", async (t) => {
  const root = fixture(t);
  registerHarness("collaborate-invalid-planners", { async run() { return response('{"summary":"missing tasks"}'); } });
  let workerCalled = false;
  const outcome = await runCollaborate(root, { task: "Fix source", planners: ["test/p1", "test/p2"], workers: ["test/worker"], writePaths: ["source.js"], commands: [["npm", "test"]], dryRun: true }, { plannerHarness: "collaborate-invalid-planners", workerHarness: { async run() { workerCalled = true; } } });
  assert.equal(outcome.status, "plan_rejected");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.audit.selected_plan, null);
  assert.equal(workerCalled, false);
});

test("collaborate executes dependencies and transfers only a passing patch", async (t) => {
  const root = fixture(t, true);
  registerHarness("collaborate-apply-planners", { async run() { return response(plan); } });
  let readerFinished = false;
  registerHarness("collaborate-apply-workers", { async run(home, prompt) {
    if (prompt.includes('"role":"reader"')) {
      readerFinished = true;
      return response("Change subtraction-style behavior to the expected behavior.");
    }
    assert.equal(readerFinished, true);
    assert.match(prompt, /Dependency artifact: review/);
    const worktree = home.split(`${path.sep}.alters${path.sep}`)[0];
    writeFileSync(path.join(worktree, "source.js"), "export const ready = true;\n");
    return response("Implemented source readiness.");
  } });
  let gateCalls = 0;
  const outcome = await runCollaborate(root, { task: "Fix source", planners: ["test/p1", "test/p2"], workers: ["test/worker"], writePaths: ["source.js"], commands: [["npm", "test"]], apply: true }, {
    plannerHarness: "collaborate-apply-planners", workerHarness: "collaborate-apply-workers", concurrency: 2,
    commandRunner: async (workspace, argv) => { gateCalls++; return commandResult(argv, readFileSync(path.join(workspace, "source.js"), "utf8").includes("true")); },
  });
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.ok, true);
  assert.equal(gateCalls, 2);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export const ready = true;\n");
  assert.deepEqual(outcome.audit.application.changedFiles, ["source.js"]);
  assert.equal(outcome.report.report.totals.succeeded_tasks, 2);
  assert.equal("graph_home" in outcome.audit.application.execution, false);
});

test("collaborate leaves the source unchanged when the final gate fails", async (t) => {
  const root = fixture(t, true);
  registerHarness("collaborate-gate-planners", { async run() { return response(plan); } });
  registerHarness("collaborate-gate-workers", { async run(home, prompt) {
    if (prompt.includes('"role":"writer"')) {
      const worktree = home.split(`${path.sep}.alters${path.sep}`)[0];
      writeFileSync(path.join(worktree, "source.js"), "export const ready = true;\n");
    }
    return response("Task completed.");
  } });
  let gateCalls = 0;
  const outcome = await runCollaborate(root, { task: "Fix source", planners: ["test/p1", "test/p2"], workers: ["test/worker"], writePaths: ["source.js"], commands: [["npm", "test"]], apply: true }, {
    plannerHarness: "collaborate-gate-planners", workerHarness: "collaborate-gate-workers",
    commandRunner: async (_workspace, argv) => { gateCalls++; return commandResult(argv, false); },
  });
  assert.equal(outcome.status, "gate_failed");
  assert.equal(outcome.ok, false);
  assert.equal(gateCalls, 2);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export const ready = false;\n");
  assert.match(readFileSync(outcome.audit.application.patch, "utf8"), /ready = true/);
});

test("collaborate apply rejects a dirty source checkout before invoking workers", async (t) => {
  const root = fixture(t, true);
  writeFileSync(path.join(root, "source.js"), "export const ready = 'dirty';\n");
  registerHarness("collaborate-dirty-planners", { async run() { return response(plan); } });
  let workerCalled = false;
  const outcome = await runCollaborate(root, { task: "Fix source", planners: ["test/p1", "test/p2"], workers: ["test/worker"], writePaths: ["source.js"], commands: [["npm", "test"]], apply: true }, {
    plannerHarness: "collaborate-dirty-planners", workerHarness: { async run() { workerCalled = true; } },
  });
  assert.equal(outcome.status, "apply_rejected");
  assert.match(outcome.audit.application.error, /clean working tree/);
  assert.equal(workerCalled, false);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export const ready = 'dirty';\n");
});
