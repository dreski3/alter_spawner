import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "task-set-v1.json");
const routes = new Set(["billing", "technical", "sales", "uppercase"]);
const splits = new Set(["development", "held_out"]);
const kinds = new Set(["classification", "extraction", "reasoning", "image", "tool"]);
const behaviors = new Set(["valid", "out_of_set", "error", "timeout"]);

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const loadTaskSet = () => {
  const bytes = readFileSync(source);
  const set = JSON.parse(bytes);
  validateTaskSet(set);
  return { set, sha256: createHash("sha256").update(bytes).digest("hex") };
};

export const validateTaskSet = (set) => {
  requireValue(set?.schema_version === 1 && set.id === "routing-benchmark-v1", "invalid benchmark task set version");
  for (const key of ["tasks", "router_cases", "nested_workloads"]) {
    requireValue(Array.isArray(set[key]) && set[key].length > 0, `${key} must be non-empty`);
  }
  const ids = new Set();
  const seenCanaries = new Set();
  const accept = (entry) => {
    requireValue(typeof entry.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id), "invalid benchmark case id");
    requireValue(!ids.has(entry.id), `duplicate benchmark case id: ${entry.id}`);
    requireValue(splits.has(entry.split), `invalid split: ${entry.id}`);
    ids.add(entry.id);
  };
  for (const task of set.tasks) {
    accept(task);
    requireValue(kinds.has(task.kind) && typeof task.prompt === "string" && task.prompt.trim(), `invalid task: ${task.id}`);
    const grading = task.grading;
    requireValue(["exact", "json_fields", "rubric", "tool_result"].includes(grading?.type), `invalid grading: ${task.id}`);
    if (grading.type === "rubric") requireValue(Array.isArray(grading.criteria) && grading.criteria.length >= 2, `missing rubric: ${task.id}`);
    else requireValue(grading.expected != null, `missing expected answer: ${task.id}`);
    if (grading.type === "tool_result") requireValue(typeof grading.required_tool === "string", `missing required tool: ${task.id}`);
    if (task.kind === "extraction") requireValue(task.output_contract?.type === "json" && grading.type === "json_fields", `invalid extraction contract: ${task.id}`);
    if (task.kind === "image") {
      requireValue(typeof task.image === "string" && /^fixtures\/[a-z-]+\.png$/.test(task.image), `invalid image path: ${task.id}`);
      requireValue(existsSync(path.join(here, task.image)), `missing image fixture: ${task.id}`);
    }
  }
  for (const item of set.router_cases) {
    accept(item);
    requireValue(typeof item.signal === "string" && item.signal.trim() && typeof item.payload === "string", `invalid router input: ${item.id}`);
    requireValue(Array.isArray(item.expected_routes) && item.expected_routes.length > 0 && item.expected_routes.every((route) => routes.has(route)), `invalid route label: ${item.id}`);
    requireValue(behaviors.has(item.adviser?.behavior), `invalid adviser behavior: ${item.id}`);
    requireValue(item.adviser.behavior === "valid" ? routes.has(item.adviser.route) : item.adviser.route == null, `invalid adviser route: ${item.id}`);
    requireValue(item.expected_outcome === (item.adviser.behavior === "out_of_set" ? "invalid" : item.adviser.behavior), `wrong outcome label: ${item.id}`);
    requireValue(item.fallback_route == null || routes.has(item.fallback_route), `invalid fallback route: ${item.id}`);
    const selected = item.adviser.behavior === "valid" ? item.adviser.route : item.fallback_route || null;
    requireValue(item.expected_selected_route === selected, `wrong selected-route label: ${item.id}`);
    requireValue(selected == null || item.expected_routes.includes(selected), `selected route is outside acceptable labels: ${item.id}`);
    const canaries = item.payload.match(/CANARY_[A-Z0-9_]+/g) || [];
    requireValue(canaries.length === 1 && !seenCanaries.has(canaries[0]) && !item.signal.includes(canaries[0]), `router canary missing, duplicated, or leaked into signal: ${item.id}`);
    seenCanaries.add(canaries[0]);
  }
  const matrix = new Set();
  for (const item of set.nested_workloads) {
    accept(item);
    requireValue(["chain", "branch"].includes(item.shape) && [1, 2, 4, 8].includes(item.max_depth), `invalid nested workload: ${item.id}`);
    const key = `${item.shape}:${item.max_depth}`;
    requireValue(!matrix.has(key), `duplicate nested workload: ${key}`);
    matrix.add(key);
    for (const fault of [item.retry, item.failure].filter(Boolean)) {
      requireValue(Number.isInteger(fault.depth) && fault.depth <= item.max_depth && fault.depth >= 0, `invalid fault depth: ${item.id}`);
      requireValue(fault.branch === "spine" || (item.shape === "branch" && fault.branch === "side" && fault.depth > 0), `invalid fault branch: ${item.id}`);
    }
  }
  requireValue(matrix.size === 8, "nested workload matrix must include both shapes at depths 1, 2, 4, and 8");
  for (const kind of kinds) requireValue(set.tasks.some((task) => task.kind === kind), `missing task kind: ${kind}`);
  for (const route of routes) requireValue(set.router_cases.some((item) => item.expected_selected_route === route), `missing route: ${route}`);
  for (const behavior of behaviors) requireValue(set.router_cases.some((item) => item.adviser.behavior === behavior), `missing adviser behavior: ${behavior}`);
  return set;
};

export const scoreTask = (task, observation) => {
  const answer = typeof observation?.text === "string" ? observation.text.trim() : "";
  const harnessOk = observation?.ok === true;
  let quality = null;
  if (task.grading.type === "exact") quality = Number(answer.toLocaleLowerCase() === String(task.grading.expected).trim().toLocaleLowerCase());
  if (task.grading.type === "json_fields") {
    try {
      const actual = JSON.parse(answer);
      quality = Number(actual && typeof actual === "object" && !Array.isArray(actual) &&
        Object.entries(task.grading.expected).every(([key, value]) => actual[key] === value));
    } catch { quality = 0; }
  }
  if (task.grading.type === "tool_result") {
    const calls = observation?.tools?.byName?.[task.grading.required_tool] ?? observation?.tools?.by_name?.[task.grading.required_tool] ?? 0;
    quality = Number(answer === task.grading.expected && calls > 0);
  }
  return { case_id: task.id, harness_ok: harnessOk, quality_score: quality, needs_blinded_review: task.grading.type === "rubric" };
};

export const blindReviewPacket = (task, observation) => {
  requireValue(task.grading.type === "rubric", "task does not use a rubric");
  return { case_id: task.id, prompt: task.prompt, answer: observation?.text ?? "", criteria: [...task.grading.criteria] };
};

export const scoreBlindReview = (task, ratings) => {
  requireValue(task.grading.type === "rubric", "task does not use a rubric");
  requireValue(Array.isArray(ratings) && ratings.length === task.grading.criteria.length &&
    ratings.every((rating) => rating === 0 || rating === 1), "rubric ratings must be one 0 or 1 per criterion");
  return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
};

export const fixturePath = (relative) => path.join(here, relative);

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { set, sha256 } = loadTaskSet();
  process.stdout.write(JSON.stringify({ id: set.id, sha256, tasks: set.tasks.length, router_cases: set.router_cases.length, nested_workloads: set.nested_workloads.length }, null, 2) + "\n");
}
