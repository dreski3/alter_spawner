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
