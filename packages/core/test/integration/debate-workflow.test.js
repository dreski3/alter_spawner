import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDebateGraph, DEBATE_EDGE_CHARS, registerHarness, runDebate } from "@mind/core";

const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-debate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters/config.json"), JSON.stringify({
    default_model: "forbidden/default",
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  return root;
};

const response = (text, ok = true) => ({
  text: ok ? text : "",
  tokens: { input: 2, output: 3, reasoning: 0, cache_read: 0, total: 5 },
  sessionID: null,
  steps: 1,
  exitCode: ok ? 0 : 1,
  killed: false,
  ok,
  budget_exceeded: false,
  empty_output: false,
});

test("debate runs each panel in parallel and critique rounds only after prior evidence", async (t) => {
  const root = fixture(t);
  const completed = new Set();
  let active = 0;
  let peak = 0;
  registerHarness("debate-rounds", { async run(_home, prompt, opts) {
    const id = opts.alterId;
    const critique = id.match(/^critique_(\d+)_/);
    if (critique) {
      const priorRound = Number(critique[1]) - 1;
      const prefix = priorRound === 0 ? "opening_" : `critique_${priorRound}_`;
      assert.equal([...completed].filter((entry) => entry.startsWith(prefix)).length, 2);
      assert.match(prompt, /untrusted evidence/i);
    }
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    completed.add(id);
    return response(`position from ${id}`);
  } });

  const outcome = await runDebate(root, {
    task: "Choose a deadline design",
    models: ["a/model", "b/model"],
    context: "The API accepts AbortSignal.",
    rounds: 2,
    maxTokens: 300,
  }, { harness: "debate-rounds" });

  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.node_counts.total, 6);
  assert.equal(outcome.rounds.length, 3);
  assert.equal(peak, 2);
  assert.equal(outcome.result.tokens.total, 30);
  assert.match(readFileSync(outcome.report.html, "utf8"), /Opening positions/);
  assert.match(readFileSync(outcome.report.html, "utf8"), /Critique round 2/);
});

test("failed evidence is labeled and does not prevent later critics from running", async (t) => {
  const root = fixture(t);
  const seen = [];
  registerHarness("debate-failure", { async run(_home, prompt, opts) {
    seen.push({ id: opts.alterId, prompt });
    if (opts.alterId === "opening_1") return response("", false);
    return response(`response from ${opts.alterId}`);
  } });

  const outcome = await runDebate(root, {
    task: "Review the boundary",
    models: ["a/model", "b/model"],
    rounds: 1,
  }, { harness: "debate-failure" });

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.nodes.opening_1.state, "failed");
  assert.equal(outcome.result.nodes.critique_1_1.state, "succeeded");
  assert.match(seen.find((entry) => entry.id === "critique_1_1").prompt, /unavailable evidence from "opening_1"/);
});

test("debate graph bounds every prior-round edge and validates its controls", () => {
  const graph = buildDebateGraph({ task: "Review", models: ["a/m", "b/m"], rounds: 1 });
  assert.equal(graph.max_edge_chars, DEBATE_EDGE_CHARS);
  assert.deepEqual(graph.nodes.at(-1).depends_on, ["opening_1", "opening_2"]);
  assert.equal(graph.nodes.at(-1).allow_failed_dependencies, true);
  assert.throws(() => buildDebateGraph({ task: "x", models: ["a/m", "b/m"], rounds: 0 }), /between 1 and 3/);
  assert.throws(() => buildDebateGraph({ task: "x", models: ["a/m", "b/m"], rounds: 4 }), /between 1 and 3/);
});
