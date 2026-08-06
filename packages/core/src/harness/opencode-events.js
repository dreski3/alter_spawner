export const createOpenCodeAccumulator = () => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
  text: "",
  sessionID: null,
  steps: 0,
  // What the run actually *did*, as opposed to what it spent. `steps` counts model
  // turns, which is not a tool count: a step may call several tools or none, so the two
  // numbers answer different questions and neither substitutes for the other.
  tools: { calls: 0, errors: 0, byName: {} },
  // opencode emits one `tool_use` per state transition, so a single call can arrive
  // twice — once running, once completed. Counting events would inflate every total, so
  // calls are counted by `callID` and the last state seen for that id wins.
  toolStates: new Map(),
});

const consumeToolEvent = (accumulator, part, emit) => {
  const callId = part.callID || part.callId || null;
  const name = part.tool || "(unnamed)";
  const status = part.state?.status || "unknown";
  // Anything still in flight is not yet a fact about the run: an interrupted call would
  // otherwise be counted as one that happened.
  if (status !== "completed" && status !== "error") return;
  const key = callId || `${name}:${accumulator.tools.calls}:${status}`;
  const previous = accumulator.toolStates.get(key);
  if (previous === status) return;
  accumulator.toolStates.set(key, status);
  if (previous === undefined) {
    accumulator.tools.calls += 1;
    accumulator.tools.byName[name] = (accumulator.tools.byName[name] || 0) + 1;
  } else if (previous === "error") {
    // A retried call that finally succeeded: the call was already counted, only its
    // outcome changed.
    accumulator.tools.errors -= 1;
  }
  if (status === "error") accumulator.tools.errors += 1;
  emit({
    type: "tool.used",
    tool: name,
    callID: callId,
    status,
    tools: { calls: accumulator.tools.calls, errors: accumulator.tools.errors, byName: { ...accumulator.tools.byName } },
    sessionID: accumulator.sessionID,
  });
};

export const consumeOpenCodeEvent = (line, accumulator, onEvent) => {
  const text = line.trim();
  if (!text) return false;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return false;
  }
  if (!accumulator.sessionID && event.sessionID) accumulator.sessionID = event.sessionID;
  const emit = (runtimeEvent) => {
    try {
      onEvent?.(runtimeEvent);
    } catch {}
  };
  if (event.type === "step_finish") {
    const tokens = event.part?.tokens || {};
    accumulator.tokens.input += tokens.input || 0;
    accumulator.tokens.output += tokens.output || 0;
    accumulator.tokens.reasoning += tokens.reasoning || 0;
    accumulator.tokens.cache_read += tokens.cache?.read || 0;
    accumulator.tokens.total += tokens.total || 0;
    accumulator.steps += 1;
    emit({
      type: "usage.updated",
      tokens: { ...accumulator.tokens },
      steps: accumulator.steps,
      sessionID: accumulator.sessionID,
    });
  } else if (event.type === "tool_use") {
    if (event.part?.type === "tool" || event.part?.tool) consumeToolEvent(accumulator, event.part, emit);
  } else if (event.type === "text") {
    const delta = event.part?.text || "";
    accumulator.text += delta;
    if (delta) {
      emit({
        type: "output.delta",
        delta,
        text: accumulator.text,
        sessionID: accumulator.sessionID,
      });
    }
  }
  return true;
};

export const classifyOpenCodeResult = ({ exitCode, killed, budgetExceeded, text }) => {
  const clean = exitCode === 0 && !killed && !budgetExceeded;
  const empty_output = clean && String(text || "").trim() === "";
  return { ok: clean && !empty_output, empty_output, budget_exceeded: !!budgetExceeded };
};
