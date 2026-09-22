import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseValidationCommand, runValidationCommand, validateAcceptanceContract } from "@mind/core";

const contract = (argv, file = "source.js") => ({
  summary: "The focused check must pass.",
  commands: [{ argv, purpose: "Run the focused test", expected_exit_code: 0, timeout_ms: 1000 }],
  relevant_files: [file],
  negative_cases: [{ case: "Invalid input", expected: "It remains rejected" }],
});

test("validation commands are explicit JSON argv without shell interpretation", () => {
  assert.deepEqual(parseValidationCommand('["npm","test"]'), ["npm", "test"]);
  assert.throws(() => parseValidationCommand("npm test"), /JSON argv array/);
  assert.throws(() => parseValidationCommand('["npm",""]'), /non-empty string arguments/);
});

test("acceptance contracts cannot replace commands, widen timeouts, or escape paths", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "validate-contract-"));
  const outside = mkdtempSync(path.join(tmpdir(), "validate-outside-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(path.join(root, "source.js"), "export {};");
  writeFileSync(path.join(outside, "secret"), "no");
  const resolvePath = (base, relative) => relative === undefined ? base : path.resolve(base, relative);
  const controls = { root, allowedCommands: [["npm", "test"]], allowedFiles: ["source.js"], commandTimeoutMs: 1000, resolvePath };
  assert.equal(validateAcceptanceContract(contract(["npm", "test"]), controls).summary, "The focused check must pass.");
  assert.deepEqual(
    validateAcceptanceContract({ ...contract(["npm", "test"]), negative_cases: ["A regression must fail."] }, controls).negative_cases,
    [{ case: "A regression must fail.", expected: "The stated invariant must hold." }],
  );
  assert.throws(() => validateAcceptanceContract(contract(["sh", "-c", "anything"]), controls), /not the operator-approved argv/);
  assert.throws(() => validateAcceptanceContract({ ...contract(["npm", "test"]), commands: [{ ...contract(["npm", "test"]).commands[0], timeout_ms: 1001 }] }, controls), /timeout ceiling/);
  assert.throws(() => validateAcceptanceContract(contract(["npm", "test"], "../validate-outside-/secret"), controls), /outside the project/);
  writeFileSync(path.join(root, "hidden.js"), "export {};");
  assert.throws(() => validateAcceptanceContract(contract(["npm", "test"], "hidden.js"), controls), /not supplied as context/);
});

test("validation command runner records output and exit state", async () => {
  const result = await runValidationCommand(process.cwd(), [process.execPath, "-e", "process.stdout.write('ok')"], { timeoutMs: 2000 });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timed_out, false);
  assert.equal(result.aborted, false);
});
