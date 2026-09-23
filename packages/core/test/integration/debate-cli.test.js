import test from "node:test";
import assert from "node:assert/strict";
import { formatDebate, parseDebateArgs } from "../../../cli/src/commands/work.js";

test("debate CLI parses bounded rounds and shared workflow controls", () => {
  assert.deepEqual(parseDebateArgs([
    "--model", "a/model",
    "--model", "b/model",
    "--rounds", "2",
    "--executor", "codex",
    "--max-tokens", "500",
    "--concurrency", "2",
    "--json",
    "Review this",
  ]), {
    help: false,
    task: "Review this",
    models: ["a/model", "b/model"],
    contextFiles: [],
    maxTokens: 500,
    concurrency: 2,
    json: true,
    rounds: 2,
    executor: "codex",
  });
  assert.equal(parseDebateArgs(["--model", "a/m", "--model", "b/m", "task"]).rounds, 1);
  assert.throws(() => parseDebateArgs(["--model", "a/m", "--model", "b/m", "--rounds", "4", "task"]), /no greater than 3/);
});

test("debate terminal output is grouped by round with aggregate usage", () => {
  const node = {
    id: "opening_1", model: "a/model", state: "succeeded", text: "Position A", error: null,
    executor: "opencode", attempts: 1, duration_ms: 100,
    tokens: { input: 2, output: 3, reasoning: 0, cache_read: 0, total: 5 }, estimated_api_cost_usd: 0.001,
  };
  const output = formatDebate({
    home: "/tmp/debate",
    result: {
      ok: true, state: "completed", node_counts: { succeeded: 1, total: 1 }, duration_ms: 100,
      tokens: node.tokens,
    },
    report: { html: "/tmp/debate/debate.html", json: "/tmp/debate/debate-report.json", report: { totals: { estimated_api_cost_usd: 0.001 }, nodes: [node] } },
    rounds: [{ round: 0, phase: "opening", entries: [{ ...node, reviewer: 1, phase: "opening" }] }],
  });
  assert.match(output, /Debate summary/);
  assert.match(output, /1 opening \+ 0 critique rounds/);
  assert.match(output, /Opening positions/);
  assert.match(output, /Position A/);
  assert.match(output, /debate\.html/);
});
