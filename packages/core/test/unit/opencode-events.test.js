import test from "node:test";
import assert from "node:assert/strict";
import { consumeOpenCodeEvent, createOpenCodeAccumulator } from "../../src/harness/opencode-events.js";

test("OpenCode events accumulate tokens, text, steps, and session identity", () => {
  const accumulator = createOpenCodeAccumulator();
  consumeOpenCodeEvent(JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "hello " } }), accumulator);
  consumeOpenCodeEvent(JSON.stringify({ type: "text", sessionID: "session-2", part: { text: "world" } }), accumulator);
  consumeOpenCodeEvent(JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 2, output: 3, reasoning: 1, total: 6, cache: { read: 4 } } },
  }), accumulator);

  assert.equal(accumulator.text, "hello world");
  assert.equal(accumulator.sessionID, "session-1");
  assert.equal(accumulator.steps, 1);
  assert.deepEqual(accumulator.tokens, { input: 2, output: 3, reasoning: 1, cache_read: 4, total: 6 });
});

// The shape asserted here is opencode 1.18's, captured from a real `--format json` run:
// one `tool_use` event whose `part` carries the tool name, a `callID` and a state whose
// `status` is what says the call actually happened.
const toolEvent = (tool, callID, status = "completed") =>
  JSON.stringify({ type: "tool_use", sessionID: "session-1", part: { type: "tool", tool, callID, state: { status } } });

test("OpenCode events count tool calls by name, once per call id", () => {
  const accumulator = createOpenCodeAccumulator();
  const events = [];
  const observe = (event) => events.push(event);
  consumeOpenCodeEvent(toolEvent("read", "call-1", "running"), accumulator, observe);
  consumeOpenCodeEvent(toolEvent("read", "call-1"), accumulator, observe);
  consumeOpenCodeEvent(toolEvent("read", "call-1"), accumulator, observe);
  consumeOpenCodeEvent(toolEvent("bash", "call-2"), accumulator, observe);
  consumeOpenCodeEvent(toolEvent("read", "call-3"), accumulator, observe);

  // Three calls, not five events: `running` is not yet a call, and a repeated
  // `completed` for one call id is the same call reported twice.
  assert.deepEqual(accumulator.tools, { calls: 3, errors: 0, byName: { read: 2, bash: 1 } });
  assert.deepEqual(events.map((event) => event.type), ["tool.used", "tool.used", "tool.used"]);
  assert.equal(events[0].tool, "read");
  assert.equal(events[0].status, "completed");
});

test("OpenCode events count a failed tool call once, and stop counting it on success", () => {
  const accumulator = createOpenCodeAccumulator();
  consumeOpenCodeEvent(toolEvent("bash", "call-1", "error"), accumulator);
  assert.deepEqual(accumulator.tools, { calls: 1, errors: 1, byName: { bash: 1 } });

  consumeOpenCodeEvent(toolEvent("bash", "call-1", "completed"), accumulator);
  assert.deepEqual(accumulator.tools, { calls: 1, errors: 0, byName: { bash: 1 } });
});

test("OpenCode tool counting is independent of step counting", () => {
  const accumulator = createOpenCodeAccumulator();
  consumeOpenCodeEvent(toolEvent("read", "call-1"), accumulator);
  consumeOpenCodeEvent(toolEvent("grep", "call-2"), accumulator);
  consumeOpenCodeEvent(JSON.stringify({ type: "step_finish", part: { tokens: { total: 9 } } }), accumulator);

  // One model turn, two tools. Reporting `steps` as a tool count would have said one.
  assert.equal(accumulator.steps, 1);
  assert.equal(accumulator.tools.calls, 2);
});

test("OpenCode event parsing ignores malformed and blank lines", () => {
  const accumulator = createOpenCodeAccumulator();
  assert.equal(consumeOpenCodeEvent("", accumulator), false);
  assert.equal(consumeOpenCodeEvent("not-json", accumulator), false);
  assert.deepEqual(accumulator, createOpenCodeAccumulator());
});

test("OpenCode events expose incremental output and usage to observers", () => {
  const accumulator = createOpenCodeAccumulator();
  const events = [];
  consumeOpenCodeEvent(
    JSON.stringify({ type: "text", sessionID: "session-live", part: { text: "stream " } }),
    accumulator,
    (event) => events.push(event),
  );
  consumeOpenCodeEvent(
    JSON.stringify({ type: "text", sessionID: "session-live", part: { text: "me" } }),
    accumulator,
    (event) => events.push(event),
  );
  consumeOpenCodeEvent(
    JSON.stringify({ type: "step_finish", part: { tokens: { output: 2, total: 2 } } }),
    accumulator,
    (event) => events.push(event),
  );

  assert.deepEqual(events.map((event) => event.type), ["output.delta", "output.delta", "usage.updated"]);
  assert.equal(events[0].delta, "stream ");
  assert.equal(events[1].text, "stream me");
  assert.equal(events[2].tokens.total, 2);
});
