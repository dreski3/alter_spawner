import test from "node:test";
import assert from "node:assert/strict";
import { formatValidate, parseValidateArgs } from "../../../cli/src/commands/work.js";

test("validate CLI parses explicit immutable commands and ceilings", () => {
  assert.deepEqual(parseValidateArgs([
    "--model", "a/designer", "--command", '["npm","test"]', "--context", "source.js", "--max-tokens", "500",
    "--command-timeout-ms", "1000", "--deadline-ms", "5000", "--max-cost-usd", "0.25", "--dry-run", "--json", "Check it",
  ]), {
    help: false, task: "Check it", model: "a/designer", commands: [["npm", "test"]], contextFiles: ["source.js"],
    maxTokens: 500, commandTimeoutMs: 1000, deadlineMs: 5000, maxCostUsd: 0.25, dryRun: true, json: true,
  });
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "--command", "npm test", "task"]), /JSON argv array/);
  assert.throws(() => parseValidateArgs(["--model", "a/designer", "task"]), /between 1 and 8/);
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
