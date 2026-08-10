import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";

export const DEFAULT_CONFIG = {
  // Who this mind *is*, as opposed to where it currently sits. Minted once by
  // `mind init` and never derived from the path, because the alternative — a directory
  // basename — makes identity a property of the filesystem: `mv` orphans the mind's
  // memory, and `~/work/scribe` and `~/backup/scribe` are the same mind as far as the
  // store is concerned. Null here means "not yet minted"; every real root has one.
  agent_id: null,
  // The human handle. Mutable on purpose — renaming a mind must not re-identify it,
  // which is the whole reason these are two fields instead of one.
  name: null,
  // Escape hatch for a store that predates `agent_id`. The memory file carries its
  // `project_id` and refuses to open under a different one, so a mind that already has
  // records keeps naming them with the old id while `agent_id` becomes its real
  // identity everywhere else. Null on anything created after this existed.
  memory_project_id: null,
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

const configPath = (root) => path.join(kitDir(root), "config.json");

// 128 bits of hex — a UUID's entropy without the dashes, so the id drops unquoted into
// a filename, a SQLite column, a log line or a registry key without escaping. It is
// deliberately opaque: anything legible would invite reading meaning into it, and the
// legible field is `name`.
export const mintAgentId = (runtimeOverride) => resolveRuntime(runtimeOverride).randomId(32);

// The identity *as recorded*, with no defaults filled in — callers need to distinguish
// "this root has no id yet" from "this root's id happens to equal the default", which
// `readConfig` cannot express.
export const readAgentIdentity = (root) => {
  try {
    const raw = JSON.parse(readFileSync(configPath(root), "utf8"));
    return {
      agentId: typeof raw?.agent_id === "string" && raw.agent_id ? raw.agent_id : null,
      name: typeof raw?.name === "string" && raw.name ? raw.name : null,
      memoryProjectId:
        typeof raw?.memory_project_id === "string" && raw.memory_project_id ? raw.memory_project_id : null,
    };
  } catch {
    return { agentId: null, name: null, memoryProjectId: null };
  }
};

// Gives a root an identity if it lacks one, and is otherwise a no-op — the single place
// allowed to write `agent_id`, so "never rewrite an existing id" is one invariant in one
// function rather than a rule every caller has to remember. Adopting a root that
// predates identity (or that a registry rescan turns up) is the same operation as
// minting one, which is why this is not folded into `mind init`.
export const ensureAgentIdentity = (root, { name = null, memoryProjectId = null, runtime } = {}) => {
  const existing = readAgentIdentity(root);
  const agentId = existing.agentId || mintAgentId(runtime);
  const resolvedName = existing.name || name || path.basename(path.resolve(root));
  const resolvedMemoryProjectId = existing.memoryProjectId || memoryProjectId;
  if (
    existing.agentId === agentId &&
    existing.name === resolvedName &&
    existing.memoryProjectId === resolvedMemoryProjectId
  ) {
    return { ...existing, minted: false };
  }
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath(root), "utf8")) || {};
  } catch {
    raw = { ...DEFAULT_CONFIG };
  }
  mkdirSync(kitDir(root), { recursive: true });
  writeJsonAtomic(configPath(root), {
    ...raw,
    agent_id: agentId,
    name: resolvedName,
    ...(resolvedMemoryProjectId ? { memory_project_id: resolvedMemoryProjectId } : {}),
  });
  return {
    agentId,
    name: resolvedName,
    memoryProjectId: resolvedMemoryProjectId,
    minted: existing.agentId === null,
  };
};

// The one place that answers "what does this root call its memory records?". An explicit
// argument wins (the host still passes a literal today), then a legacy pin, then the
// durable id, and only then the basename — which is the pre-identity behaviour, kept as
// a last resort so a nestable Alter's ephemeral child root, which is a run artifact
// rather than a mind and never gets an `agent_id`, keeps working unchanged.
export const resolveProjectId = (root, explicit = null) => {
  if (explicit) return explicit;
  const { agentId, memoryProjectId } = readAgentIdentity(root);
  return memoryProjectId || agentId || path.basename(path.resolve(root));
};
