import test from "node:test";
import assert from "node:assert/strict";
import { formatValidate, parseValidateArgs } from "../../../cli/src/commands/work.js";

test("validate CLI parses explicit immutable commands and ceilings", () => {
  assert.deepEqual(parseValidateArgs([
    "--model", "a/designer", "--command", '["npm","test"]', "--context", "source.js", "--max-tokens", "500",
    "--command-timeout-ms", "1000", "--deadline-ms", "5000", "--max-cost-usd", "0.25", "--dry-run", "--json", "Check it",
  ]), {
    help: false, task: "Check it", model: "a/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    maxTokens: 500, commandTimeoutMs: 1000, deadlineMs: 5000, maxCostUsd: 0.25, dryRun: true,
    apply: false, maxRepairs: 1, implementerMaxTokens: 16000, writePaths: [], json: true,
  });
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "--command", "npm test", "task"]), /JSON argv array/);
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "task"]), /between 1 and 8/);
});

test("validate CLI requires an explicit implementer and write boundary for apply", () => {
  assert.deepEqual(parseValidateArgs([
    "--model", "a/designer", "--command", '["npm","test"]', "--apply",
    "--implementer", "b/implementer", "--write", "packages/core/src", "--max-repairs", "2", "Fix it",
  ]), {
    help: false, task: "Fix it", model: "a/designer", commands: [["npm", "test"]], contextFiles: [],
    maxTokens: 4000, commandTimeoutMs: 300000, deadlineMs: 900000, maxCostUsd: null, dryRun: false,
    apply: true, maxRepairs: 2, implementerMaxTokens: 16000, writePaths: ["packages/core/src"], json: false,
    implementer: "b/implementer",
  });
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "--command", '["npm","test"]', "--apply", "task"]), /requires --implementer/);
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "--command", '["npm","test"]', "--apply", "--implementer", "b/implementer", "task"]), /--write paths/);
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "--command", '["npm","test"]', "--apply", "--dry-run", "--implementer", "b/implementer", "--write", "src", "task"]), /mutually exclusive/);
});

test("validate terminal output leads with gate, usage, cost, and artifact locations", () => {
  const output = formatValidate({
    home: "/tmp/validate", status: "passed",
    result: { node_counts: { succeeded: 1, total: 1 }, duration_ms: 10, tokens: { input: 1, output: 2, reasoning: 0, cache_read: 0, total: 3 } },
    audit: { dry_run: false, contract: { summary: "Run tests", commands: [{ argv: ["npm", "test"] }] }, gate: [{ ok: true }] },
    report: { html: "/tmp/validate/validate.html", json: "/tmp/validate/validate-report.json", report: { designer: { model: "a/designer" }, totals: { estimated_api_cost_usd: 0.001 } } },
  });
  assert.match(output, /Validate summary/);
  assert.match(output, /Status      passed/);
  assert.match(output, /1\/1 commands passed/);
  assert.match(output, /validate\.html/);
  assert.match(output, /validation\.json/);
});

test("validate terminal output explains an implementer failure", () => {
  const output = formatValidate({
    home: "/tmp/validate", status: "implementation_failed",
    result: { node_counts: { succeeded: 1, total: 1 }, duration_ms: 10, tokens: { input: 1, output: 2, reasoning: 0, cache_read: 0, total: 3 } },
    audit: {
      dry_run: false,
      contract: { summary: "Run tests", commands: [{ argv: ["npm", "test"] }] },
      gate: [],
      application: {
        status: "implementation_failed", applied: false, baselineGate: [], finalGate: [], changedFiles: [], patch: null,
        attempts: [{ error: "exceeded its 8000-token budget" }],
      },
    },
    report: { html: "/tmp/validate/validate.html", json: "/tmp/validate/validate-report.json", report: { designer: { model: "a/designer" }, totals: { estimated_api_cost_usd: 0.001 } } },
  });
  assert.match(output, /Implementer failed/);
  assert.match(output, /exceeded its 8000-token budget/);
});
