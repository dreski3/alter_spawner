import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkflowConcurrency, selectWorkflowExecutors } from "@mind/core";

test("workflow nodes automatically prefer direct execution when the model supports it", () => {
  const seen = [];
  const graph = selectWorkflowExecutors({
    id: "automatic-executors",
    nodes: [
      { id: "direct", model: "xai/grok", prompt: "one", textOnly: true },
      { id: "oauth", model: "openai/luna", prompt: "two", textOnly: true },
      { id: "forced", model: "xai/grok", prompt: "three", textOnly: true, executor: "opencode" },
      { id: "toolful", model: "xai/grok", prompt: "four", textOnly: false },
    ],
  }, {
    env: { MARKER: "test" },
    providers: { native: { protocol: "openai-responses" } },
    resolveDirect(model, env, providers) {
      seen.push({ model, env, providers });
      if (model.startsWith("openai/")) throw new Error("OAuth requires OpenCode");
      return {};
    },
  });

  assert.equal(graph.nodes[0].executor, "llm");
  assert.equal(graph.nodes[1].executor, "opencode");
  assert.equal(graph.nodes[2].executor, "opencode", "an explicit override must win");
  assert.equal(graph.nodes[3].executor, undefined, "tool-capable nodes must keep the sandbox executor path");
  assert.deepEqual(seen.map(({ model }) => model), ["xai/grok", "openai/luna"]);
  assert.equal(seen[0].env.MARKER, "test");
  assert.equal(seen[0].providers.native.protocol, "openai-responses");
});

test("multiple OpenCode workflow nodes share one attached server and remain concurrent", async () => {
  let starts = 0;
  let stops = 0;
  const prepared = await prepareWorkflowConcurrency({
    nodes: [
      { id: "one", executor: "opencode" },
      { id: "two", executor: "opencode" },
      { id: "direct", executor: "llm" },
    ],
  }, { runtime: { env: { PATH: "/bin" }, marker: true } }, {
    async startServer({ environment }) {
      starts++;
      assert.equal(environment.PATH, "/bin");
      return {
        environment: { ...environment, OPENCODE_SERVER_URL: "http://127.0.0.1:4567", OPENCODE_SERVER_PASSWORD: "secret" },
        async stop() { stops++; },
      };
    },
  });

  assert.equal(starts, 1);
  assert.equal(prepared.options.executorConcurrency.opencode, 2);
  assert.equal(prepared.options.runtime.env.OPENCODE_SERVER_URL, "http://127.0.0.1:4567");
  assert.equal(prepared.options.runtime.marker, true);
  await prepared.stop();
  assert.equal(stops, 1);
});
