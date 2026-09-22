import test from "node:test";
import assert from "node:assert/strict";
import { parseCollaborateArgs } from "../../../cli/src/commands/work.js";

test("collaborate CLI parses explicit planners, workers, boundaries, gates, and budgets", () => {
  assert.deepEqual(parseCollaborateArgs([
    "--planner", "a/planner", "--planner", "b/planner", "--worker", "c/worker",
    "--write", "src", "--command", '["npm","test"]', "--dry-run", "--max-tasks", "4",
    "--concurrency", "3", "--planner-max-tokens", "2000", "--task-max-tokens", "5000",
    "--max-total-tokens", "20000", "--context", "src/file.js", "Plan it",
  ]), {
    help: false, task: "Plan it", planners: ["a/planner", "b/planner"], workers: ["c/worker"],
    commands: [["npm", "test"]], contextFiles: ["src/file.js"], writePaths: ["src"], maxTasks: 4,
    concurrency: 3, plannerMaxTokens: 2000, taskMaxTokens: 5000, maxTotalTokens: 20000,
    commandTimeoutMs: 300000, deadlineMs: 1200000, dryRun: true, apply: false, json: false,
  });
  assert.throws(() => parseCollaborateArgs(["--planner", "a/p", "--planner", "b/p", "--worker", "c/w", "--write", "src", "--command", '["npm","test"]', "task"]), /exactly one/);
});
