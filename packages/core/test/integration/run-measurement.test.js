import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, createSpawnOptions, registerHarness, spawnAlter, summarizeRunTree } from "../../src/index.js";

test("wall timing and usage cover a four-level Alter run", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-run-measurement-"));
  if (process.env.MIND_KEEP_MEASUREMENT_RUNS === "1") process.stdout.write(`measurement root: ${root}\n`);
  else t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  const providers = { local: { models: { model: {
    input: ["text"], capabilities: ["reasoning"], residency: "local", context_tokens: 8192,
    cost: { input_per_million: 1, output_per_million: 2 },
  } } } };
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "local/model",
    providers,
    max_depth: 6,
    max_tree_nodes: 8,
    max_concurrent_alters: 1,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  registerHarness("measurement-deep", {
    supportsRetry: false,
    async run(home, prompt, options) {
      if (options.depth < 3) {
        const child = await spawnAlter(home, createSpawnOptions({
          name: `level-${options.depth + 1}`,
          prompt,
          model: "local/model",
          executor: "measurement-deep",
          nestable: options.depth < 2,
        }), { runtime: createRuntime({ env: {
          ...options.environment,
          ALTER_DEPTH: String(options.depth),
          ALTER_ID: options.alterId,
        } }) });
        assert.equal(child.result.ok, true);
      }
      return {
        ok: true,
        text: "done",
        tokens: { input: 2, output: 1, reasoning: 0, cache_read: 0, total: 3 },
        steps: 1,
        exitCode: 0,
        killed: false,
        budget_exceeded: false,
        empty_output: false,
        sessionID: null,
      };
    },
  });
  const run = await spawnAlter(root, createSpawnOptions({
    name: "level-0",
    prompt: "work",
    model: "local/model",
    executor: "measurement-deep",
    nestable: true,
  }));
  const summary = summarizeRunTree(root, run.home);
  assert.equal(summary.runs, 4);
  assert.equal(summary.max_depth, 3);
  assert.equal(summary.tokens.total, 12);
  assert.equal(summary.estimated_api_cost_usd, 0.000016);
  assert.equal(summary.missing_token_usage_attempts, 0);
  assert.equal(summary.missing_price_attempts, 0);
  assert.equal(summary.tree_wall_duration_ms, run.result.timing.wall_duration_ms);
  assert.ok(summary.summed_node_wall_duration_ms >= summary.tree_wall_duration_ms);
  assert.ok(run.result.tree_id);
  assert.deepEqual(run.result.attempts[0].pricing.input, ["text"]);
  assert.deepEqual(run.result.attempts[0].pricing.capabilities, ["reasoning"]);
  assert.equal(run.result.attempts[0].pricing.residency, "local");
  assert.equal(run.result.attempts[0].pricing.context_tokens, 8192);
  assert.ok(run.result.timing.wall_duration_ms >= run.result.timing.pre_persistence_duration_ms);
  assert.deepEqual(JSON.parse(readFileSync(path.join(run.home, "result.json"), "utf8")).timing, run.result.timing);
  assert.ok(run.result.timing.wall_duration_ms >= run.result.timing.execution_ms);
  assert.ok(run.result.timing.execution_ms >= run.result.timing.attempts_ms);
  assert.ok(run.result.timing.scaffold_ms >= 0);
  providers.local.models.model.cost.input_per_million = 500;
  assert.equal(summarizeRunTree(root, run.home, { providers }).estimated_api_cost_usd, 0.000016);
});

test("a failure before scaffolding leaves a sanitized measurement", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-run-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ default_model: "local/model" }));
  const events = [];
  const error = await spawnAlter(root, createSpawnOptions({
    name: "blocked",
    prompt: "private payload",
    routing: { strategy: "ordered" },
  }), { onEvent: (event) => events.push(event) }).then(() => null, (cause) => cause);
  assert.equal(error.measurement.phase, "before_home");
  assert.equal(events.at(-1).type, "run.failed");
  const files = readdirSync(path.join(root, ".alters", "measurements"));
  assert.equal(files.length, 1);
  const record = readFileSync(path.join(root, ".alters", "measurements", files[0]), "utf8");
  assert.deepEqual(JSON.parse(record), error.measurement);
  assert.equal(record.includes("private payload"), false);
});
