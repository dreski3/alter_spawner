import path from "node:path";
import { sanitizeName } from "./util.js";
import { fail } from "./util.js";

export const MAX_COLLABORATE_TASKS = 16;

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) fail(`${label} must contain exactly: ${expected.join(", ")}.`);
};

const nonempty = (value, label) => {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
};

const normalizeRelative = (value, label) => {
  const raw = nonempty(value, label);
  if (path.isAbsolute(raw)) fail(`${label} must be project-relative.`);
  const normalized = path.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) fail(`${label} is outside the project.`);
  const first = normalized.toLowerCase().split(path.sep)[0];
  if ([".git", ".alters"].includes(first)) fail(`${label} is protected.`);
  return normalized;
};

const within = (candidate, boundary) => candidate === boundary || candidate.startsWith(boundary + path.sep);

const dependsTransitively = (tasks, start, wanted, seen = new Set()) => {
  if (seen.has(start)) return false;
  seen.add(start);
  const task = tasks.get(start);
  return task.depends_on.some((dependency) => dependency === wanted || dependsTransitively(tasks, dependency, wanted, seen));
};

export const validateCollaboratePlan = (value, {
  workers,
  writePaths,
  maxTasks = 8,
  taskMaxTokens = 12000,
  availableTaskTokens = 92000,
} = {}) => {
  exactKeys(value, ["summary", "tasks"], "collaboration plan");
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > maxTasks || value.tasks.length > MAX_COLLABORATE_TASKS) {
    fail(`collaboration plan tasks must contain between 1 and ${Math.min(maxTasks, MAX_COLLABORATE_TASKS)} entries.`);
  }
  const allowedModels = new Set(workers || []);
  const boundaries = (writePaths || []).map((entry, index) => normalizeRelative(entry, `write path ${index + 1}`));
  const tasks = new Map();
  const normalized = value.tasks.map((task, index) => {
    const label = `collaboration task ${index + 1}`;
    exactKeys(task, ["allowed_paths", "depends_on", "expected_output", "id", "instructions", "max_tokens", "model", "role", "title"], label);
    const id = nonempty(task.id, `${label}.id`);
    if (sanitizeName(id) !== id) fail(`${label}.id must be a safe lowercase identifier.`);
    if (tasks.has(id)) fail(`duplicate collaboration task id: ${id}`);
    if (!Array.isArray(task.depends_on) || task.depends_on.some((dependency) => typeof dependency !== "string" || !dependency)) fail(`${label}.depends_on must be an array of task ids.`);
    if (!Array.isArray(task.allowed_paths)) fail(`${label}.allowed_paths must be an array.`);
    if (!allowedModels.has(task.model)) fail(`${label}.model is not an operator-approved worker model.`);
    if (!['reader', 'writer'].includes(task.role)) fail(`${label}.role must be reader or writer.`);
    if (!Number.isInteger(task.max_tokens) || task.max_tokens < 1 || task.max_tokens > taskMaxTokens) fail(`${label}.max_tokens must be between 1 and ${taskMaxTokens}.`);
    const allowedPaths = task.allowed_paths.map((entry, pathIndex) => normalizeRelative(entry, `${label}.allowed_paths[${pathIndex}]`));
    if (task.role === "reader" && allowedPaths.length) fail(`${label} is read-only and cannot declare allowed_paths.`);
    if (task.role === "writer" && !allowedPaths.length) fail(`${label} must declare at least one allowed path.`);
    for (const allowed of allowedPaths) {
      if (!boundaries.some((boundary) => within(allowed, boundary))) fail(`${label} path is outside the operator write boundary: ${allowed}`);
    }
    const item = {
      id,
      title: nonempty(task.title, `${label}.title`),
      role: task.role,
      model: task.model,
      depends_on: [...new Set(task.depends_on)],
      instructions: nonempty(task.instructions, `${label}.instructions`),
      allowed_paths: [...new Set(allowedPaths)],
      expected_output: nonempty(task.expected_output, `${label}.expected_output`),
      max_tokens: task.max_tokens,
    };
    tasks.set(id, item);
    return item;
  });
  for (const task of normalized) {
    for (const dependency of task.depends_on) {
      if (!tasks.has(dependency)) fail(`collaboration task "${task.id}" has unknown dependency "${dependency}".`);
      if (dependency === task.id) fail(`collaboration task "${task.id}" cannot depend on itself.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail(`collaboration plan contains a dependency cycle at "${id}".`);
    if (visited.has(id)) return;
    visiting.add(id);
    tasks.get(id).depends_on.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  normalized.forEach((task) => visit(task.id));
  const writers = normalized.filter((task) => task.role === "writer");
  if (!writers.length) fail("collaboration plan requires at least one writer task.");
  for (let index = 1; index < writers.length; index++) {
    if (!dependsTransitively(tasks, writers[index].id, writers[index - 1].id)) fail(`writer task "${writers[index].id}" must depend transitively on prior writer "${writers[index - 1].id}".`);
  }
  const reservedTokens = normalized.reduce((sum, task) => sum + task.max_tokens, 0);
  if (reservedTokens > availableTaskTokens) fail(`collaboration plan reserves ${reservedTokens} task tokens, above the available ${availableTaskTokens}.`);
  return { summary: nonempty(value.summary, "collaboration plan.summary"), tasks: normalized, reserved_tokens: reservedTokens };
};

export const selectCollaboratePlan = (candidates) => {
  const valid = candidates.filter((candidate) => candidate.plan);
  if (!valid.length) return null;
  return [...valid].sort((left, right) =>
    left.plan.tasks.length - right.plan.tasks.length ||
    left.plan.reserved_tokens - right.plan.reserved_tokens ||
    left.planner_index - right.planner_index
  )[0];
};
