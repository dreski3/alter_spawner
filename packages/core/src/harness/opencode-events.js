export const createOpenCodeAccumulator = () => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
  text: "",
  sessionID: null,
  steps: 0,
});

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
