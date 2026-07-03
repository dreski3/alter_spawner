import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  default_model: "zai-coding-plan/glm-5-turbo",
  max_depth: 5,
  run_timeout_ms: 180000,
  catalog_dir: "catalog",
  default_fallback_model: null,
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
