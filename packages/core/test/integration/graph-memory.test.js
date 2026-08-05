import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerHarness, runAlterGraph } from "@mind/core";

const prompts = [];

registerHarness("memory-cycle-stub", {
  needsAgentHome: false,
  run: async (_home, prompt) => {
    prompts.push(prompt);
    return {
      tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
      text: prompt.startsWith("produce") ? "new durable fact" : "consumer completed",
      sessionID: null,
      steps: 1,
      exitCode: 0,
      killed: false,
      ok: true,
      budget_exceeded: false,
      empty_output: false,
    };
  },
});

const project = (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-graph-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ default_model: "test/model", retry: { same_harness_retries: 0, fallback_retries: 0 } }),
  );
  return root;
};

test("graph recalls are frozen before execution and curation targets the next cycle", async (t) => {
  prompts.length = 0;
  const root = project(t);
  const stored = [];
  const recallCalls = [];
  const curateCalls = [];
  const recall = async (_root, options) => {
    recallCalls.push({ prompt: options.prompt, scope: options.scope, visible: [...stored] });
    const results = stored.map((content, index) => ({ record: { id: `mem_${index + 1}`, content } }));
    return {
      results,
      context: results.length ? `\nMEMORY:${results.map((result) => result.record.content).join(",")}` : "",
    };
  };
  const curate = async (_root, options) => {
    assert.equal(prompts.length, 2, "curation began before all graph nodes completed");
    curateCalls.push(options);
    stored.push(options.content);
    return { records: [{ id: `mem_${stored.length}` }] };
  };

  const { result } = await runAlterGraph(root, {
    id: "memory-cycle",
    output: "consumer",
    nodes: [
      {
        id: "producer",
        prompt: "produce",
        executor: "memory-cycle-stub",
        memory: { curate: { namespace: "findings" } },
      },
      {
        id: "consumer",
        prompt: "consume {{result:producer}}",
        depends_on: ["producer"],
        executor: "memory-cycle-stub",
        memory: { recall: { namespace: "findings", query: "durable facts" } },
      },
    ],
  }, {
    memory: {
      scope: { project: "naut" },
      recall,
      curate,
    },
  });

  assert.equal(recallCalls.length, 1);
  assert.deepEqual(recallCalls[0].visible, []);
  assert.deepEqual(recallCalls[0].scope, { project: "naut", namespace: "findings" });
  assert.equal(curateCalls.length, 1);
  assert.equal(prompts[1].includes("MEMORY:new durable fact"), false);
  assert.equal(result.memory_cycle.consistency, "next-cycle");
  assert.equal(result.memory_cycle.state, "completed");
  assert.equal(result.memory_cycle.curated_records, 1);
  assert.equal(result.nodes.consumer.memory.recall.state, "succeeded");
  assert.equal(result.nodes.producer.memory.curate.state, "succeeded");
});

test("memory workflow failures are visible but do not discard successful graph work", async (t) => {
  prompts.length = 0;
  const root = project(t);
  const { result } = await runAlterGraph(root, {
    id: "memory-best-effort",
    nodes: [{ id: "worker", prompt: "work", executor: "memory-cycle-stub", memory: { recall: true, curate: true } }],
  }, {
    memory: {
      scope: { project: "naut" },
      recall: async () => { throw new Error("recall unavailable"); },
      curate: async () => { throw new Error("curator unavailable"); },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.nodes.worker.memory.recall.state, "failed");
  assert.match(result.nodes.worker.memory.recall.error, /recall unavailable/);
  assert.equal(result.nodes.worker.memory.curate.state, "failed");
  assert.match(result.nodes.worker.memory.curate.error, /curator unavailable/);
});
