import assert from "node:assert/strict";
import test from "node:test";
import { describeAlterFailure } from "@mind/core";

const result = (overrides) => ({
  budget_exceeded: false,
  contract_failed: false,
  contract_error: null,
  empty_output: false,
  aborted: false,
  killed: false,
  max_tokens: 400,
  tokens: { input: 282, output: 149, reasoning: 126, cache_read: 0, total: 431 },
  ...overrides,
});

test("a budget failure names the numbers that caused it and what to change", () => {
  const message = describeAlterFailure(result({ budget_exceeded: true }));
  // The case this exists for: the node's text was correct and it still failed, because
  // reasoning tokens counted against a cap sized for the visible output.
  assert.match(message, /400-token budget/);
  assert.match(message, /used 431/);
  assert.match(message, /126 of them reasoning/);
  assert.match(message, /raise maxTokens/);
});

test("a budget failure on a model that does not reason omits the reasoning clause", () => {
  const message = describeAlterFailure(result({
    budget_exceeded: true,
    tokens: { input: 10, output: 500, reasoning: 0, cache_read: 0, total: 510 },
  }));
  assert.match(message, /used 510/);
  assert.doesNotMatch(message, /reasoning/);
});

test("each distinct failure mode reads differently", () => {
  assert.match(describeAlterFailure(result({ contract_failed: true, contract_error: "not JSON" })), /contract not met: not JSON/);
  assert.match(describeAlterFailure(result({ empty_output: true })), /no output/);
  assert.match(describeAlterFailure(result({ aborted: true })), /cancelled/);
  assert.match(describeAlterFailure(result({ killed: true })), /timed out/);
  assert.equal(describeAlterFailure(result({ llm_error: "cerebras returned 429" })), "cerebras returned 429");
  // Nothing recognisable still says something rather than throwing.
  assert.equal(describeAlterFailure(result({})), "alter run failed");
});

test("a budget failure is reported ahead of a contract failure it caused", () => {
  // Truncating at the cap usually breaks the contract too; the budget is the root cause
  // and the actionable one, so it must not be masked by the symptom.
  const message = describeAlterFailure(result({ budget_exceeded: true, contract_failed: true, contract_error: "not JSON" }));
  assert.match(message, /budget/);
});
