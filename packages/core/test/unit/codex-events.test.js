import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexResult,
  consumeCodexEvent,
  createCodexAccumulator,
} from "../../src/harness/codex-events.js";

test("Codex events accumulate the final message, session, usage, and tools", () => {
  const accumulator = createCodexAccumulator();
  const events = [];
  const consume = (event) => consumeCodexEvent(JSON.stringify(event), accumulator, (value) => events.push(value));

  consume({ type: "thread.started", thread_id: "thread-1" });
  consume({
    type: "item.completed",
    item: { id: "item-1", type: "command_execution", command: "rg x", exit_code: 0, status: "completed" },
  });
  consume({
    type: "item.completed",
    item: { id: "item-2", type: "file_change", status: "failed" },
  });
  consume({ type: "item.completed", item: { id: "item-3", type: "agent_message", text: "done" } });
  consume({
    type: "turn.completed",
    usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 },
  });

  assert.equal(accumulator.sessionID, "thread-1");
  assert.equal(accumulator.text, "done");
  assert.equal(accumulator.steps, 1);
  assert.deepEqual(accumulator.tokens, { input: 9, output: 5, reasoning: 2, cache_read: 4, total: 14 });
  assert.deepEqual(accumulator.tools, { calls: 2, errors: 1, byName: { shell: 1, apply_patch: 1 } });
  assert.deepEqual(events.map((event) => event.type), ["tool.used", "tool.used", "output.delta", "usage.updated"]);
});

test("Codex events keep the last assistant message and ignore duplicate tool completions", () => {
  const accumulator = createCodexAccumulator();
  const tool = { type: "item.completed", item: { id: "same", type: "web_search", status: "completed" } };
  consumeCodexEvent(JSON.stringify(tool), accumulator);
  consumeCodexEvent(JSON.stringify(tool), accumulator);
  consumeCodexEvent(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }), accumulator);
  consumeCodexEvent(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }), accumulator);

  assert.equal(accumulator.text, "final");
  assert.deepEqual(accumulator.tools, { calls: 1, errors: 0, byName: { web_search: 1 } });
});

test("Codex event parsing records failures and ignores malformed input", () => {
  const accumulator = createCodexAccumulator();
  assert.equal(consumeCodexEvent("", accumulator), false);
  assert.equal(consumeCodexEvent("not-json", accumulator), false);
  assert.equal(consumeCodexEvent(JSON.stringify({ type: "turn.failed", error: { message: "model failed" } }), accumulator), true);
  assert.equal(accumulator.error, "model failed");
});

test("Codex result classification matches the harness contract", () => {
  assert.deepEqual(
    classifyCodexResult({ exitCode: 0, killed: false, budgetExceeded: false, text: "done" }),
    { ok: true, empty_output: false, budget_exceeded: false },
  );
  assert.deepEqual(
    classifyCodexResult({ exitCode: 0, killed: false, budgetExceeded: false, text: "" }),
    { ok: false, empty_output: true, budget_exceeded: false },
  );
  assert.deepEqual(
    classifyCodexResult({ exitCode: 0, killed: true, budgetExceeded: true, text: "partial" }),
    { ok: false, empty_output: false, budget_exceeded: true },
  );
});
