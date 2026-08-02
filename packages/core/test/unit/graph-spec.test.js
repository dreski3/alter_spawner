import test from "node:test";
import assert from "node:assert/strict";
import { buildGraphSpawnOptions, renderGraphPrompt, validateGraph } from "../../src/graph-spec.js";

test("graph specs validate dependencies and render declared results", () => {
  const graph = {
    nodes: [
      { id: "draft", prompt: "draft" },
      { id: "review", depends_on: ["draft"], prompt: "Review {{result:draft}}" },
    ],
  };
  const validated = validateGraph(graph);
  assert.equal(validated.output, "review");
  assert.equal(renderGraphPrompt(validated.nodes.get("review"), { draft: { result: { text: "answer" } } }), "Review answer");
});

test("graph specs reject undeclared result references and cycles", () => {
  assert.throws(
    () => validateGraph({ nodes: [{ id: "review", prompt: "Use {{result:draft}}" }] }),
    /without declaring it/,
  );
  assert.throws(
    () => validateGraph({ nodes: [
      { id: "a", depends_on: ["b"], prompt: "a" },
      { id: "b", depends_on: ["a"], prompt: "b" },
    ] }),
    /dependency cycle/,
  );
});

test("graph nodes map to the canonical spawn contract", () => {
  const options = buildGraphSpawnOptions({ id: "worker", prompt: "work", depends_on: ["source"] }, "g1", "/mind");
  assert.equal(options.graphId, "g1");
  assert.deepEqual(options.dependsOn, ["source"]);
  assert.equal(options.spawned_by, "graph:g1");
  assert.equal(options.mindBinPath, "/mind");
});
