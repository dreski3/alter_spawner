const EMPTY_TOKENS = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });

const TOOL_NAMES = Object.freeze({
  command_execution: "shell",
  file_change: "apply_patch",
  mcp_tool_call: "mcp",
  web_search: "web_search",
});
const NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "plan_update"]);

export const createCodexAccumulator = () => ({
  tokens: EMPTY_TOKENS(),
  text: "",
  sessionID: null,
  steps: 0,
  tools: { calls: 0, errors: 0, byName: {} },
  toolIds: new Map(),
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

const consumeTool = (item, accumulator, onEvent, started = false) => {
  if (!item.type || NON_TOOL_ITEMS.has(item.type)) return;
  const name = item.type === "mcp_tool_call"
    ? [item.server, item.tool].filter(Boolean).join(".") || TOOL_NAMES[item.type]
    : TOOL_NAMES[item.type] || item.type;
  const key = item.id || `${item.type}:${accumulator.tools.calls}`;
  const failed = item.status === "failed" || item.status === "error" ||
    (Number.isInteger(item.exit_code) && item.exit_code !== 0) || !!item.error;
  if (accumulator.toolIds.has(key)) {
    if (failed && !accumulator.toolIds.get(key)) {
      accumulator.toolIds.set(key, true);
      accumulator.tools.errors += 1;
    }
    return;
  }
  accumulator.toolIds.set(key, failed);
  accumulator.tools.calls += 1;
  accumulator.tools.errors += failed ? 1 : 0;
  accumulator.tools.byName[name] = (accumulator.tools.byName[name] || 0) + 1;
  emitSafely(onEvent, {
    type: "tool.used",
    tool: name,
    callID: item.id || null,
    status: failed ? "error" : started ? "started" : "completed",
    tools: {
      calls: accumulator.tools.calls,
      errors: accumulator.tools.errors,
      byName: { ...accumulator.tools.byName },
    },
    sessionID: accumulator.sessionID,
  });
};

export const consumeCodexEvent = (line, accumulator, onEvent) => {
  const text = line.trim();
  if (!text) return false;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return false;
  }
  if (event.type === "thread.started" && event.thread_id) {
    accumulator.sessionID ||= event.thread_id;
  } else if (event.type === "item.started") {
    consumeTool(event.item || {}, accumulator, onEvent, true);
  } else if (event.type === "item.completed") {
    const item = event.item || {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      accumulator.text = item.text;
      if (item.text) {
        emitSafely(onEvent, {
          type: "output.delta",
          delta: item.text,
          text: accumulator.text,
          sessionID: accumulator.sessionID,
        });
      }
    } else {
      consumeTool(item, accumulator, onEvent);
    }
  } else if (event.type === "turn.completed") {
    const usage = event.usage || {};
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    accumulator.tokens.input += input;
    accumulator.tokens.output += output;
    accumulator.tokens.reasoning += usage.reasoning_output_tokens || 0;
    accumulator.tokens.cache_read += usage.cached_input_tokens || 0;
    accumulator.tokens.total += usage.total_tokens ?? input + output;
    accumulator.steps += 1;
    emitSafely(onEvent, {
      type: "usage.updated",
      tokens: { ...accumulator.tokens },
      steps: accumulator.steps,
      sessionID: accumulator.sessionID,
    });
  } else if (event.type === "turn.failed" || event.type === "error") {
    accumulator.error = errorText(event.error || event.message || event) || accumulator.error;
  }
  return true;
};

export const classifyCodexResult = ({ exitCode, killed, budgetExceeded, text }) => {
  const clean = exitCode === 0 && !killed && !budgetExceeded;
  const empty_output = clean && String(text || "").trim() === "";
  return { ok: clean && !empty_output, empty_output, budget_exceeded: !!budgetExceeded };
};
