// The outcome table for a finished harness run, including the empty-output case.
// Pure and offline — no `opencode` process, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../src/harness/opencode.js";

const cases = [
  {
    what: "clean exit with text is a plain success",
    in: { exitCode: 0, killed: false, budgetExceeded: false, text: "done" },
    out: { ok: true, empty_output: false, budget_exceeded: false },
  },
  {
    what: "clean exit with no text is an empty-output failure",
    in: { exitCode: 0, killed: false, budgetExceeded: false, text: "" },
    out: { ok: false, empty_output: true, budget_exceeded: false },
  },
  {
    what: "whitespace-only text counts as empty",
    in: { exitCode: 0, killed: false, budgetExceeded: false, text: "  \n\t " },
    out: { ok: false, empty_output: true, budget_exceeded: false },
  },
  {
    what: "missing text field counts as empty",
    in: { exitCode: 0, killed: false, budgetExceeded: false, text: undefined },
    out: { ok: false, empty_output: true, budget_exceeded: false },
  },
  {
    what: "a nonzero exit is not reclassified as empty output",
    in: { exitCode: 1, killed: false, budgetExceeded: false, text: "" },
    out: { ok: false, empty_output: false, budget_exceeded: false },
  },
  {
    what: "a timeout kill is not reclassified as empty output",
    in: { exitCode: -1, killed: true, budgetExceeded: false, text: "" },
    out: { ok: false, empty_output: false, budget_exceeded: false },
  },
  {
    what: "a budget overrun keeps its own reason, even with no text",
    in: { exitCode: 0, killed: true, budgetExceeded: true, text: "" },
    out: { ok: false, empty_output: false, budget_exceeded: true },
  },
  {
    what: "a budget overrun with partial text is still not ok",
    in: { exitCode: 0, killed: true, budgetExceeded: true, text: "partial" },
    out: { ok: false, empty_output: false, budget_exceeded: true },
  },
];

for (const c of cases) {
  test(`classify: ${c.what}`, () => {
    assert.deepEqual(classify(c.in), c.out);
  });
}
