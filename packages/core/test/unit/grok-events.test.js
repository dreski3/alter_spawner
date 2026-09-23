import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGrokResult,
  consumeGrokEvent,
  createGrokAccumulator,
} from "../../src/harness/grok-events.js";

test("Grok events accumulate streamed text, session, usage, and tools", () => {
  const accumulator = createGrokAccumulator();
  const events = [];
  const consume = (event) => consumeGrokEvent(JSON.stringify(event), accumulator, (value) => events.push(value));

  consume({ type: "tool_call", toolCallId: "call-1", toolName: "run_terminal_cmd", status: "in_progress" });
  consume({ type: "tool_call_update", toolCallId: "call-1", status: "completed" });
  consume({ type: "tool_call", toolCallId: "call-2", toolName: "search_replace", status: "failed" });
  consume({ type: "text", data: "fin" });
  consume({ type: "text", data: "ished" });
  consume({
    type: "usage",
    usage: {
      input_tokens: 9,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 1,
      output_tokens: 5,
      reasoning_tokens: 2,
      total_tokens: 19,
    },
  });
  consume({ type: "end", sessionId: "session-1", stopReason: "end_turn", num_turns: 1 });

  assert.equal(accumulator.sessionID, "session-1");
  assert.equal(accumulator.text, "finished");
  assert.equal(accumulator.steps, 1);
  assert.deepEqual(accumulator.tokens, { input: 9, output: 5, reasoning: 2, cache_read: 4, total: 19 });
  assert.deepEqual(accumulator.tools, { calls: 2, errors: 1, byName: { run_terminal_cmd: 1, search_replace: 1 } });
  assert.deepEqual(events.map((event) => event.type), ["tool.used", "tool.used", "output.delta", "output.delta", "usage.updated"]);
});

test("Grok events use the terminal usage when no per-response usage arrived", () => {
  const accumulator = createGrokAccumulator();
  consumeGrokEvent(JSON.stringify({
    type: "end",
    sessionId: "session-2",
    num_turns: 2,
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  }), accumulator);

  assert.equal(accumulator.sessionID, "session-2");
  assert.equal(accumulator.steps, 2);
  assert.deepEqual(accumulator.tokens, { input: 3, output: 1, reasoning: 0, cache_read: 0, total: 4 });
});

test("Grok event parsing records failures and ignores malformed input", () => {
  const accumulator = createGrokAccumulator();
  assert.equal(consumeGrokEvent("", accumulator), false);
  assert.equal(consumeGrokEvent("not-json", accumulator), false);
  assert.equal(consumeGrokEvent(JSON.stringify({ type: "error", message: "model failed" }), accumulator), true);
  assert.equal(accumulator.error, "model failed");
});

test("Grok result classification matches the harness contract", () => {
  assert.deepEqual(
    classifyGrokResult({ exitCode: 0, killed: false, budgetExceeded: false, text: "done" }),
    { ok: true, empty_output: false, budget_exceeded: false },
  );
  assert.deepEqual(
    classifyGrokResult({ exitCode: 0, killed: false, budgetExceeded: false, text: "  " }),
    { ok: false, empty_output: true, budget_exceeded: false },
  );
  assert.deepEqual(
    classifyGrokResult({ exitCode: 0, killed: true, budgetExceeded: true, text: "partial" }),
    { ok: false, empty_output: false, budget_exceeded: true },
  );
});
