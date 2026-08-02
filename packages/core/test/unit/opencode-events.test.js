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

test("OpenCode event parsing ignores malformed and blank lines", () => {
  const accumulator = createOpenCodeAccumulator();
  assert.equal(consumeOpenCodeEvent("", accumulator), false);
  assert.equal(consumeOpenCodeEvent("not-json", accumulator), false);
  assert.deepEqual(accumulator, createOpenCodeAccumulator());
});
