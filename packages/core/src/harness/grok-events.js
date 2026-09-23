const EMPTY_TOKENS = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });

export const createGrokAccumulator = () => ({
  tokens: EMPTY_TOKENS(),
  text: "",
  sessionID: null,
  steps: 0,
  tools: { calls: 0, errors: 0, byName: {} },
  toolIds: new Map(),
  sawUsage: false,
  error: null,
});

const emitSafely = (onEvent, event) => {
  try {
    onEvent?.(event);
  } catch {}
};

const errorText = (value) => {
  if (typeof value === "string") return value;
  if (typeof value?.message === "string") return value.message;
  return value == null ? null : JSON.stringify(value);
};

const failedStatus = (status) => status === "failed" || status === "error";

const consumeTool = (event, accumulator, onEvent) => {
  const name = event.toolName || "tool";
  const id = event.toolCallId || `${name}:${accumulator.tools.calls}`;
  const failed = failedStatus(event.status);
  if (!accumulator.toolIds.has(id)) {
    accumulator.toolIds.set(id, failed);
    accumulator.tools.calls += 1;
    accumulator.tools.errors += failed ? 1 : 0;
    accumulator.tools.byName[name] = (accumulator.tools.byName[name] || 0) + 1;
    emitSafely(onEvent, {
      type: "tool.used",
      tool: name,
      callID: event.toolCallId || null,
      status: failed ? "error" : "completed",
      tools: {
        calls: accumulator.tools.calls,
        errors: accumulator.tools.errors,
        byName: { ...accumulator.tools.byName },
      },
      sessionID: accumulator.sessionID,
    });
    return;
  }
  if (failed && accumulator.toolIds.get(id) !== true) {
    accumulator.toolIds.set(id, true);
    accumulator.tools.errors += 1;
  }
};

const applyUsage = (accumulator, usage = {}) => {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  accumulator.tokens.input += input;
  accumulator.tokens.output += output;
  accumulator.tokens.reasoning += usage.reasoning_tokens || 0;
  accumulator.tokens.cache_read += cacheRead;
  accumulator.tokens.total += usage.total_tokens ?? input + cacheRead + cacheCreate + output;
  accumulator.sawUsage = true;
};

export const consumeGrokEvent = (line, accumulator, onEvent) => {
  const text = line.trim();
  if (!text) return false;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return false;
  }
  if (event.type === "text" && typeof event.data === "string") {
    accumulator.text += event.data;
    if (event.data) {
      emitSafely(onEvent, {
        type: "output.delta",
        delta: event.data,
        text: accumulator.text,
        sessionID: accumulator.sessionID,
      });
    }
  } else if (event.type === "tool_call" || event.type === "tool_call_update") {
    consumeTool(event, accumulator, onEvent);
  } else if (event.type === "usage") {
    applyUsage(accumulator, event.usage);
    accumulator.steps += 1;
    emitSafely(onEvent, {
      type: "usage.updated",
      tokens: { ...accumulator.tokens },
      steps: accumulator.steps,
      sessionID: accumulator.sessionID,
    });
  } else if (event.type === "end") {
    const sessionId = event.sessionId || event.session_id;
    if (sessionId) accumulator.sessionID ||= sessionId;
    if (!accumulator.sawUsage && event.usage) {
      applyUsage(accumulator, event.usage);
      accumulator.steps = event.num_turns || 1;
      emitSafely(onEvent, {
        type: "usage.updated",
        tokens: { ...accumulator.tokens },
        steps: accumulator.steps,
        sessionID: accumulator.sessionID,
      });
    } else if (!accumulator.steps && event.num_turns) {
      accumulator.steps = event.num_turns;
    }
  } else if (event.type === "error") {
    accumulator.error = errorText(event.message || event.error || event) || accumulator.error;
  }
  return true;
};

export const classifyGrokResult = ({ exitCode, killed, budgetExceeded, text }) => {
  const clean = exitCode === 0 && !killed && !budgetExceeded;
  const empty_output = clean && String(text || "").trim() === "";
  return { ok: clean && !empty_output, empty_output, budget_exceeded: !!budgetExceeded };
};
