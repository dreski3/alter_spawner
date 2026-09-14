import test from "node:test";
import assert from "node:assert/strict";
import { selectCollaboratePlan, validateCollaboratePlan } from "@mind/core";

const options = { workers: ["test/reader", "test/writer"], writePaths: ["src"], maxTasks: 6, taskMaxTokens: 5000, availableTaskTokens: 10000 };
const plan = () => ({
  summary: "Inspect then implement.",
  tasks: [
    { id: "inspect", title: "Inspect", role: "reader", model: "test/reader", depends_on: [], instructions: "Analyze supplied context.", allowed_paths: [], expected_output: "A focused recommendation.", max_tokens: 2000 },
    { id: "implement", title: "Implement", role: "writer", model: "test/writer", depends_on: ["inspect"], instructions: "Apply the recommendation.", allowed_paths: ["src/file.js"], expected_output: "A concise change summary.", max_tokens: 4000 },
  ],
});

test("collaborate validates a bounded task DAG and records its reservation", () => {
  const validated = validateCollaboratePlan(plan(), options);
  assert.equal(validated.reserved_tokens, 6000);
  assert.deepEqual(validated.tasks[1].depends_on, ["inspect"]);
});

test("collaborate rejects cycles, unapproved models, paths, and unordered writers", () => {
  const cyclic = plan();
  cyclic.tasks[0].depends_on = ["implement"];
  assert.throws(() => validateCollaboratePlan(cyclic, options), /dependency cycle/);
  const model = plan();
  model.tasks[1].model = "other/model";
  assert.throws(() => validateCollaboratePlan(model, options), /not an operator-approved/);
  const escaped = plan();
  escaped.tasks[1].allowed_paths = ["test/file.js"];
  assert.throws(() => validateCollaboratePlan(escaped, options), /outside the operator write boundary/);
  const writers = plan();
  writers.tasks.push({ ...writers.tasks[1], id: "second", depends_on: [] });
  assert.throws(() => validateCollaboratePlan(writers, options), /must depend transitively/);
});

test("collaborate chooses the smallest valid plan, then its reservation and planner order", () => {
  const larger = validateCollaboratePlan({ ...plan(), tasks: [...plan().tasks, { id: "verify", title: "Verify", role: "reader", model: "test/reader", depends_on: ["implement"], instructions: "Summarize evidence.", allowed_paths: [], expected_output: "Evidence.", max_tokens: 1000 }] }, options);
  const smaller = validateCollaboratePlan(plan(), options);
  const selected = selectCollaboratePlan([{ planner_index: 0, plan: larger }, { planner_index: 1, plan: smaller }]);
  assert.equal(selected.planner_index, 1);
});
