import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHarness, runAlterGraph } from "@mind/core";

const responses = {
  seed: "seed-result",
  left: "left-result",
  right: "right-result",
  join: "coherent-final-result",
};

const writeCatalog = (root, name, model, provider) => {
  const dir = path.join(root, ".alters", "catalog", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      name,
      description: `${name} test alter`,
      model,
      opencode_provider: provider,
    })
  );
};

test("runs chained and branched catalog alters with provider-specific models and a tracked join", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({
      default_model: "unused/default",
      retry: { same_harness_retries: 0, fallback_retries: 0 },
    })
  );
  writeCatalog(root, "seed-provider", "alpha/seed-model", {
    alpha: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://alpha.invalid/v1", apiKey: "{env:ALPHA_API_KEY}" },
      models: { "seed-model": {} },
    },
  });
  writeCatalog(root, "left-provider", "beta/left-model", {
    beta: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://beta.invalid/v1", apiKey: "{env:BETA_API_KEY}" },
      models: { "left-model": {} },
    },
  });
  writeCatalog(root, "right-provider", "gamma/right-model", {
    gamma: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://gamma.invalid/v1", apiKey: "{env:GAMMA_API_KEY}" },
      models: { "right-model": {} },
    },
  });
  writeCatalog(root, "join-provider", "delta/join-model", {
    delta: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://delta.invalid/v1", apiKey: "{env:DELTA_API_KEY}" },
      models: { "join-model": {} },
    },
  });

  const calls = [];
  let active = 0;
  let maxActive = 0;
  registerHarness("graph-provider-test", {
    async run(home, prompt, options) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, path.basename(home).includes("left") ? 25 : 10));
      active--;
      const alter = JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
      calls.push({ id: alter.id, home, prompt, options });
      const text = responses[alter.id];
      return {
        tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
        text,
        sessionID: `session-${alter.id}`,
        steps: 1,
        exitCode: 0,
        killed: false,
        ok: true,
        budget_exceeded: false,
        empty_output: false,
      };
    },
  });

  const { home, result } = await runAlterGraph(
    root,
    {
      id: "provider-dag",
      output: "join",
      nodes: [
        { id: "seed", catalog: "seed-provider", prompt: "Create the seed." },
        {
          id: "left",
          catalog: "left-provider",
          depends_on: ["seed"],
          prompt: "Transform left: {{result:seed}}",
        },
        {
          id: "right",
          catalog: "right-provider",
          depends_on: ["seed"],
          prompt: "Transform right: {{result:seed}}",
        },
        {
          id: "join",
          catalog: "join-provider",
          depends_on: ["left", "right"],
          prompt: "Synthesize {{result:left}} and {{result:right}}.",
        },
      ],
    },
    { harness: "graph-provider-test", concurrency: 2 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.output, "coherent-final-result");
  assert.deepEqual(result.tokens, { input: 4, output: 4, reasoning: 0, cache_read: 0, total: 8 });
  assert.deepEqual(result.node_counts, { total: 4, succeeded: 4, failed: 0, skipped: 0 });
  assert.equal(maxActive, 2, "the independent branches should run concurrently");
  assert.deepEqual(
    calls.map((call) => [call.id, call.options.model]).sort(),
    [
      ["join", "delta/join-model"],
      ["left", "beta/left-model"],
      ["right", "gamma/right-model"],
      ["seed", "alpha/seed-model"],
    ]
  );
  assert.match(calls.find((call) => call.id === "left").prompt, /seed-result/);
  assert.match(calls.find((call) => call.id === "right").prompt, /seed-result/);
  assert.match(calls.find((call) => call.id === "join").prompt, /left-result and right-result/);
  assert.ok(calls.every((call) => call.options.pure === true));
  for (const call of calls) {
    const config = JSON.parse(readFileSync(path.join(call.home, "opencode.json"), "utf8"));
    assert.ok(config.provider[call.options.model.split("/")[0]]);
  }
  const persisted = JSON.parse(readFileSync(path.join(home, "result.json"), "utf8"));
  assert.equal(persisted.output_node, "join");
  assert.equal(persisted.nodes.left.state, "succeeded");
  assert.deepEqual(persisted.nodes.join.depends_on, ["left", "right"]);
  assert.equal(persisted.nodes.join.result.graph_id, "provider-dag");
});
