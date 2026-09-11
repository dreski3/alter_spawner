import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHarness, runValidate, writeValidateReport } from "@mind/core";

const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-validate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({ default_model: "forbidden/default", retry: { same_harness_retries: 0, fallback_retries: 0 } }));
  writeFileSync(path.join(root, "source.js"), "export {};");
  return root;
};

const response = (text) => ({
  text, tokens: { input: 2, output: 3, reasoning: 0, cache_read: 0, total: 5 }, sessionID: null,
  steps: 1, exitCode: 0, killed: false, ok: true, budget_exceeded: false, empty_output: false,
});

const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

const initializeGit = (root, extraFiles = {}) => {
  for (const [file, contents] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  git(root, "init", "-q");
  git(root, "add", "source.js", ...Object.keys(extraFiles));
  git(root, "-c", "user.name=Validate Test", "-c", "user.email=validate@example.test", "commit", "-qm", "fixture");
};

const commandResult = (argv, ok, message = "") => ({
  argv, exit_code: ok ? 0 : 1, signal: null, timed_out: false, aborted: false, error: null,
  duration_ms: 1, stdout: ok ? message : "", stderr: ok ? "" : message,
  stdout_truncated: false, stderr_truncated: false,
});

const isolatedWorkspace = (prompt) => {
  const match = prompt.match(/## Isolated workspace\n([^\n]+)/);
  assert.ok(match, "implementer prompt names its isolated workspace");
  return match[1];
};

const validContract = (argv = ["npm", "test"]) => JSON.stringify({
  summary: "Run the project test suite.",
  commands: [{ argv, purpose: "Verify behavior", expected_exit_code: 0, timeout_ms: 1000 }],
  relevant_files: ["source.js"],
  negative_cases: [{ case: "Broken behavior", expected: "The test fails" }],
});

test("validate freezes the approved contract, runs the gate, and records artifacts", async (t) => {
  const root = fixture(t);
  registerHarness("validate-success", { async run() { return response(validContract()); } });
  let calls = 0;
  const outcome = await runValidate(root, {
    task: "Keep behavior correct", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"], commandTimeoutMs: 1000,
  }, { harness: "validate-success", commandRunner: async (_root, argv) => {
    calls++;
    return { argv, exit_code: 0, timed_out: false, aborted: false, error: null, duration_ms: 12, stdout: "passed", stderr: "", stdout_truncated: false, stderr_truncated: false };
  } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "passed");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(path.join(outcome.home, "validation.json"))).gate[0].ok, true);
  assert.match(readFileSync(outcome.report.html, "utf8"), /Frozen acceptance gate/);
  assert.equal(JSON.parse(readFileSync(outcome.report.json)).status, "passed");
  assert.equal(writeValidateReport(outcome.home, outcome.result).report.status, "passed");
});

test("validate rejects model-invented commands before command execution", async (t) => {
  const root = fixture(t);
  registerHarness("validate-invented", { async run() { return response(validContract(["sh", "-c", "echo unsafe"])); } });
  let called = false;
  const outcome = await runValidate(root, {
    task: "Keep behavior correct", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"], commandTimeoutMs: 1000,
  }, { harness: "validate-invented", commandRunner: async () => { called = true; } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "contract_rejected");
  assert.equal(called, false);
  assert.match(outcome.audit.contract_error, /not the operator-approved argv/);
});

test("validate dry-run freezes a contract without executing commands", async (t) => {
  const root = fixture(t);
  registerHarness("validate-dry", { async run() { return response(validContract()); } });
  const outcome = await runValidate(root, {
    task: "Keep behavior correct", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"], commandTimeoutMs: 1000, dryRun: true,
  }, { harness: "validate-dry", commandRunner: async () => { throw new Error("must not run"); } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "contract_ready");
  assert.deepEqual(outcome.audit.gate, []);
});

test("validate treats a failed command as failure and never runs later checks", async (t) => {
  const root = fixture(t);
  const commands = [["npm", "run", "check"], ["npm", "test"]];
  registerHarness("validate-gate-failure", { async run() { return response(JSON.stringify({
    summary: "Run checks in order.",
    commands: commands.map((argv) => ({ argv, purpose: "Verify", expected_exit_code: 0, timeout_ms: 1000 })),
    relevant_files: ["source.js"],
    negative_cases: [{ case: "Regression", expected: "A command fails" }],
  })); } });
  let calls = 0;
  const outcome = await runValidate(root, {
    task: "Keep behavior correct", model: "test/designer", commands, contextFiles: ["source.js"], commandTimeoutMs: 1000,
  }, { harness: "validate-gate-failure", commandRunner: async (_root, argv) => {
    calls++;
    return { argv, exit_code: 1, timed_out: false, aborted: false, error: null, duration_ms: 12, stdout: "", stderr: "failed", stdout_truncated: false, stderr_truncated: false };
  } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "gate_failed");
  assert.equal(calls, 1);
  assert.equal(outcome.audit.gate.length, 1);
});

test("validate apply transfers only a patch that passes the frozen gate", async (t) => {
  const root = fixture(t);
  initializeGit(root);
  registerHarness("validate-apply-designer", { async run() { return response(validContract()); } });
  registerHarness("validate-apply-implementer", { async run(_home, prompt) {
    writeFileSync(path.join(isolatedWorkspace(prompt), "source.js"), "export const ready = true;\n");
    return response("Implemented the requested behavior.");
  } });
  let gateCalls = 0;
  const outcome = await runValidate(root, {
    task: "Make source ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["source.js"], maxRepairs: 0,
  }, {
    harness: "validate-apply-designer", implementerHarness: "validate-apply-implementer",
    commandRunner: async (workspace, argv) => {
      gateCalls++;
      const ready = readFileSync(path.join(workspace, "source.js"), "utf8").includes("ready = true");
      return commandResult(argv, ready, ready ? "passed" : "not ready");
    },
  });
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.ok, true);
  assert.equal(gateCalls, 2, "the host runs a baseline and post-change gate");
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export const ready = true;\n");
  assert.deepEqual(outcome.audit.application.changedFiles, ["source.js"]);
  assert.equal(existsSync(outcome.audit.application.patch), true);
  assert.match(readFileSync(outcome.audit.application.patch, "utf8"), /ready = true/);
  assert.equal(outcome.report.report.aggregate_tokens.total, 10);
  assert.equal(outcome.report.report.totals.nodes, 2);
  assert.match(readFileSync(outcome.report.html, "utf8"), /Implementer attempts/);
});

test("validate apply feeds a failed frozen gate into one bounded repair", async (t) => {
  const root = fixture(t);
  initializeGit(root);
  registerHarness("validate-repair-designer", { async run() { return response(validContract()); } });
  let attempts = 0;
  registerHarness("validate-repair-implementer", { async run(_home, prompt) {
    attempts++;
    if (attempts === 2) assert.match(prompt, /Normalized prior gate failure/);
    writeFileSync(path.join(isolatedWorkspace(prompt), "source.js"), attempts === 1 ? "export const ready = false;\n" : "export const ready = true;\n");
    return response(`Attempt ${attempts}`);
  } });
  const outcome = await runValidate(root, {
    task: "Make source ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["source.js"], maxRepairs: 1,
  }, {
    harness: "validate-repair-designer", implementerHarness: "validate-repair-implementer",
    commandRunner: async (workspace, argv) => {
      const ready = readFileSync(path.join(workspace, "source.js"), "utf8").includes("ready = true");
      return commandResult(argv, ready, ready ? "passed" : "expected ready = true");
    },
  });
  assert.equal(outcome.status, "applied");
  assert.equal(attempts, 2);
  assert.equal(outcome.audit.application.attempts.length, 2);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export const ready = true;\n");
});

test("validate apply rejects changes outside the explicit write boundary", async (t) => {
  const root = fixture(t);
  initializeGit(root, { "other.js": "export const untouched = true;\n" });
  registerHarness("validate-boundary-designer", { async run() { return response(validContract()); } });
  registerHarness("validate-boundary-implementer", { async run(_home, prompt) {
    writeFileSync(path.join(isolatedWorkspace(prompt), "other.js"), "export const escaped = true;\n");
    return response("Changed another file.");
  } });
  const outcome = await runValidate(root, {
    task: "Make source ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["source.js"], maxRepairs: 0,
  }, {
    harness: "validate-boundary-designer", implementerHarness: "validate-boundary-implementer",
    commandRunner: async (_workspace, argv) => commandResult(argv, true, "passed"),
  });
  assert.equal(outcome.status, "apply_rejected");
  assert.match(outcome.audit.application.error, /outside --write: other\.js/);
  assert.equal(outcome.audit.application.attempts.length, 1);
  assert.equal(readFileSync(path.join(root, "other.js"), "utf8"), "export const untouched = true;\n");
});

test("validate apply rejects deletion even when the path is writable", async (t) => {
  const root = fixture(t);
  initializeGit(root);
  registerHarness("validate-delete-designer", { async run() { return response(validContract()); } });
  registerHarness("validate-delete-implementer", { async run(_home, prompt) {
    rmSync(path.join(isolatedWorkspace(prompt), "source.js"));
    return response("Removed the file.");
  } });
  const outcome = await runValidate(root, {
    task: "Make source ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["source.js"], maxRepairs: 0,
  }, {
    harness: "validate-delete-designer", implementerHarness: "validate-delete-implementer",
    commandRunner: async (_workspace, argv) => commandResult(argv, true, "passed"),
  });
  assert.equal(outcome.status, "apply_rejected");
  assert.match(outcome.audit.application.error, /does not permit file deletion/);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "export {};");
});

test("validate apply refuses a dirty source checkout before invoking the implementer", async (t) => {
  const root = fixture(t);
  initializeGit(root);
  writeFileSync(path.join(root, "source.js"), "dirty\n");
  registerHarness("validate-dirty-designer", { async run() { return response(validContract()); } });
  let implementerCalled = false;
  registerHarness("validate-dirty-implementer", { async run() { implementerCalled = true; return response("unexpected"); } });
  const outcome = await runValidate(root, {
    task: "Make source ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["source.js"], maxRepairs: 0,
  }, {
    harness: "validate-dirty-designer", implementerHarness: "validate-dirty-implementer",
    commandRunner: async (_workspace, argv) => commandResult(argv, true, "passed"),
  });
  assert.equal(outcome.status, "apply_rejected");
  assert.match(outcome.audit.application.error, /clean working tree/);
  assert.equal(implementerCalled, false);
  assert.equal(readFileSync(path.join(root, "source.js"), "utf8"), "dirty\n");
});

test("validate apply excludes gate-generated files from the transferred candidate patch", async (t) => {
  const root = fixture(t);
  initializeGit(root, { "editable/target.js": "export const ready = false;\n" });
  registerHarness("validate-side-effect-designer", { async run() { return response(validContract()); } });
  registerHarness("validate-side-effect-implementer", { async run(_home, prompt) {
    writeFileSync(path.join(isolatedWorkspace(prompt), "editable/target.js"), "export const ready = true;\n");
    return response("Updated the target.");
  } });
  const outcome = await runValidate(root, {
    task: "Make target ready", model: "test/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    commandTimeoutMs: 1000, apply: true, implementer: "test/implementer", writePaths: ["editable"], maxRepairs: 0,
  }, {
    harness: "validate-side-effect-designer", implementerHarness: "validate-side-effect-implementer",
    commandRunner: async (workspace, argv) => {
      writeFileSync(path.join(workspace, "editable/generated.txt"), "gate output\n");
      const ready = readFileSync(path.join(workspace, "editable/target.js"), "utf8").includes("ready = true");
      return commandResult(argv, ready, ready ? "passed" : "not ready");
    },
  });
  assert.equal(outcome.status, "applied");
  assert.deepEqual(outcome.audit.application.changedFiles, ["editable/target.js"]);
  assert.equal(existsSync(path.join(root, "editable/generated.txt")), false);
  assert.doesNotMatch(readFileSync(outcome.audit.application.patch, "utf8"), /generated\.txt/);
});
