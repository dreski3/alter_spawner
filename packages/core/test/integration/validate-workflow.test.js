import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
