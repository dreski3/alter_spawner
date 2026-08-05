import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  default_model: "zai-coding-plan/glm-5-turbo",
  // Depth bounds how long a branch gets, not how many there are, so it is only a
  // safe number in company: `max_tree_nodes` bounds the tree's total work and
  // `max_concurrent_alters` bounds how much of it runs at once. See tree-budget.js.
  max_depth: 12,
  // Total Alters one tree may spawn, counted across every branch and every process.
  max_tree_nodes: 64,
  // Total tokens one tree may spend. Off by default: a node's own `max_tokens` is
  // the per-call guard, and a tree-wide ceiling that is too low kills legitimate long
  // runs partway through, which is worse than not having it. Set it deliberately.
  max_tree_tokens: null,
  // Alters running at once across the tree. Ancestors waiting on a child do not
  // count — see tree-budget.js for why that is required, not merely generous.
  max_concurrent_alters: 4,
  run_timeout_ms: 180000,
  catalog_dir: "catalog",
  default_fallback_model: null,
  opencode_pure: true,
  opencode_event_log: false,
  retry: { same_harness_retries: 1, fallback_retries: 1 },
};

// Walks up from startDir looking for a directory containing `.alters/config.json`,
// the same way `git` walks up looking for `.git`. Returns the project root (the
// directory *containing* `.alters`), or null if none is found.
export const findProjectRoot = (startDir = process.cwd()) => {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".alters", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const requireProjectRoot = (startDir = process.cwd()) => {
  const root = findProjectRoot(startDir);
  if (!root) {
    throw new Error(
      "not a mind project (no .alters/config.json found in this or any parent directory). Run `mind init` first."
    );
  }
  return root;
};

export const kitDir = (root) => path.join(root, ".alters");

// Alter run homes live under `.alters/runs/<id>/`, not directly in `.alters/`,
// so the kit dir stays readable (just config.json + catalog/) no matter how
// many runs accumulate. Applies at every nesting level: a nestable Alter's
// own `.alters/` gets the same `runs/` subfolder for its children.
export const runsDir = (root) => path.join(kitDir(root), "runs");

export const readConfig = (root) => {
  try {
    const raw = JSON.parse(readFileSync(path.join(kitDir(root), "config.json"), "utf8"));
    return { ...DEFAULT_CONFIG, ...raw, retry: { ...DEFAULT_CONFIG.retry, ...(raw.retry || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};
