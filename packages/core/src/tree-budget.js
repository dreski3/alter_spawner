import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { withFileLock } from "./file-lock.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso, sanitizeName } from "./util.js";

// `max_depth` bounds how *long* a branch can get; it says nothing about how many
// branches there are. At the old default of 5 that was survivable. At 12 it is not:
// a router with a fan-out of 3 reaches roughly half a million nodes without ever
// violating the depth limit, and every one of them is an OS process and a model call.
//
// So a tree needs two guards that depth cannot give it: a ceiling on total work
// (`max_tree_nodes`, `max_tree_tokens`) and a ceiling on work happening at once
// (`max_concurrent_alters`). Neither can live in a process — a parent spawns two
// children that know nothing about each other, so a limit held in memory or passed
// down an environment variable is enforced once per branch instead of once per tree.
// They share a ledger file instead, serialized by withFileLock.
//
// Identity: entries are keyed by a per-run id in ALTER_NODE, not by ALTER_ID. An
// Alter's id comes from `--name` and is deliberately allowed to repeat across runs,
// so two nodes called "compress" in one tree would collide in the ledger and corrupt
// both the ancestor walk and slot release.

export const TREE_ID_ENV = "ALTER_TREE";
export const TREE_LEDGER_ENV = "ALTER_TREE_LEDGER";
export const TREE_NODE_ENV = "ALTER_NODE";
export const TREE_LEDGER_SCHEMA_VERSION = 1;

// How long a live entry may sit unrefreshed before it is treated as abandoned, for
// the case where a pid has been recycled onto an unrelated process.
const DEFAULT_ENTRY_STALE_MS = 3600000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 600000;

export const treeLedgerPath = (root, treeId) =>
  path.join(kitDir(root), "trees", `${sanitizeName(treeId)}.json`);

export const treeLimits = (cfg) => ({
  maxNodes: cfg.max_tree_nodes ?? null,
  maxTokens: cfg.max_tree_tokens ?? null,
  maxConcurrent: cfg.max_concurrent_alters ?? null,
});

// With every limit switched off there is nothing to serialize, so the tree pays no
// ledger, no lock, and no extra file at all.
export const treeGuardsEnabled = (limits) =>
  limits.maxNodes != null || limits.maxTokens != null || limits.maxConcurrent != null;

const emptyLedger = (treeId, startedAt) => ({
  schema_version: TREE_LEDGER_SCHEMA_VERSION,
  tree_id: treeId,
  started_at: startedAt,
  nodes_admitted: 0,
  tokens_spent: 0,
  live: [],
});

// A missing ledger is the normal first-spawn case. A ledger that exists but cannot be
// read is not: silently starting a fresh one would reset the counters and remove the
// ceiling precisely when something has already gone wrong, so this fails closed.
const readLedger = (file, treeId, startedAt) => {
  if (!existsSync(file)) return emptyLedger(treeId, startedAt);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`tree ledger is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.live)) {
    fail(`tree ledger is malformed: ${file}`);
  }
  return {
    ...emptyLedger(treeId, startedAt),
    ...parsed,
    nodes_admitted: Number(parsed.nodes_admitted) || 0,
    tokens_spent: Number(parsed.tokens_spent) || 0,
    live: parsed.live.filter((entry) => entry && typeof entry.id === "string"),
  };
};

const pruneDead = (live, runtime, staleMs) => {
  const now = runtime.now();
  return live.filter((entry) => {
    if (!runtime.isProcessAlive(entry.pid)) return false;
    const started = Date.parse(entry.started_at);
    return !Number.isFinite(started) || now - started < staleMs;
  });
};

// Walks from a node's parent up to the root of the live set. An Alter that is waiting
// on a child is not doing work — it is a suspended frame — so counting it against the
// concurrency cap would be wrong twice over: it overstates load, and it deadlocks.
// With a cap of 4 and a chain 5 deep, every slot ends up held by an ancestor that can
// only finish once its descendant runs, and the descendant can never be admitted.
// Excluding ancestors makes progress unconditional: the deepest node in any branch
// competes only with genuinely parallel work.
const ancestorsOf = (live, parentNodeId) => {
  const byId = new Map(live.map((entry) => [entry.id, entry]));
  const seen = new Set();
  let cursor = parentNodeId;
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    cursor = byId.get(cursor).parent_id;
  }
  return seen;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeLimit = (reason, ledger, limits) => {
  if (reason === "nodes") {
    return `tree node budget exhausted: ${ledger.nodes_admitted}/${limits.maxNodes} alters already spawned in tree "${ledger.tree_id}" (raise max_tree_nodes to allow more).`;
  }
  return `tree token budget exhausted: ${ledger.tokens_spent}/${limits.maxTokens} tokens already spent in tree "${ledger.tree_id}" (raise max_tree_tokens to allow more).`;
};

// Reserves one node of the tree's budget and one concurrency slot, blocking while the
// tree is at its concurrency ceiling and failing outright once a budget is spent.
// Returns the ledger handle the caller must hand back to `releaseTreeNode`.
export const admitTreeNode = async ({
  file,
  treeId,
  parentNodeId = null,
  depth = 0,
  limits,
  runtime: runtimeOverride,
  lock = {},
  admissionTimeoutMs = DEFAULT_ADMISSION_TIMEOUT_MS,
  entryStaleMs = DEFAULT_ENTRY_STALE_MS,
  pollMs = 50,
}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const nodeId = runtime.randomId(12);
  const deadline = Date.now() + admissionTimeoutMs;
  while (true) {
    const outcome = await withFileLock(
      file,
      () => {
        const startedAt = iso(runtime.now());
        const ledger = readLedger(file, treeId, startedAt);
        ledger.live = pruneDead(ledger.live, runtime, entryStaleMs);
        if (limits.maxNodes != null && ledger.nodes_admitted >= limits.maxNodes) {
          return { admitted: false, reason: "nodes", message: describeLimit("nodes", ledger, limits) };
        }
        if (limits.maxTokens != null && ledger.tokens_spent >= limits.maxTokens) {
          return { admitted: false, reason: "tokens", message: describeLimit("tokens", ledger, limits) };
        }
        if (limits.maxConcurrent != null) {
          const ancestors = ancestorsOf(ledger.live, parentNodeId);
          const working = ledger.live.filter((entry) => !ancestors.has(entry.id)).length;
          if (working >= limits.maxConcurrent) {
            // Persist the prune so a crashed holder's slot is freed for whoever polls
            // next, then back off outside the lock.
            writeJsonAtomic(file, ledger);
            return { admitted: false, reason: "concurrency" };
          }
        }
        ledger.nodes_admitted += 1;
        ledger.live.push({
          id: nodeId,
          parent_id: parentNodeId,
          pid: runtime.pid,
          depth,
          started_at: startedAt,
        });
        writeJsonAtomic(file, ledger);
        return { admitted: true, nodeId, nodesAdmitted: ledger.nodes_admitted };
      },
      lock,
    );
    if (outcome.admitted) return { file, nodeId, treeId, limits, lock, runtime };
    if (outcome.reason !== "concurrency") fail(outcome.message);
    if (Date.now() >= deadline) {
      fail(
        `timed out waiting for a concurrency slot in tree "${treeId}" (max_concurrent_alters=${limits.maxConcurrent}).`,
      );
    }
    await wait(pollMs);
  }
};

// Frees the slot and records what the node spent. Token accounting is necessarily
// after the fact — the cost is only known once the run is over — so `max_tree_tokens`
// stops the *next* spawn rather than the one that crossed the line. `max_tree_nodes`
// has no such caveat; it is checked before anything runs.
export const releaseTreeNode = async (handle, tokensSpent = 0) => {
  if (!handle) return null;
  const { file, nodeId, treeId, runtime, lock } = handle;
  return withFileLock(
    file,
    () => {
      const ledger = readLedger(file, treeId, iso(runtime.now()));
      ledger.live = ledger.live.filter((entry) => entry.id !== nodeId);
      ledger.tokens_spent += Number(tokensSpent) || 0;
      writeJsonAtomic(file, ledger);
      return ledger;
    },
    lock,
  );
};

export const readTreeLedger = (file) => {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
};

// The root of a tree mints its id and the absolute path of the ledger; every nested
// spawn inherits both through the environment, exactly as depth already travels. The
// path has to be absolute because a nestable Alter runs `mind` from inside its own
// home, where `.alters/` resolves to its private child kit rather than the project's.
export const resolveTreeContext = (root, o, runtime) => {
  const inherited = runtime.env[TREE_ID_ENV];
  const treeId = inherited || `tree_${runtime.randomId(8)}`;
  const file = runtime.env[TREE_LEDGER_ENV] || treeLedgerPath(root, treeId);
  return { treeId, file, parentNodeId: runtime.env[TREE_NODE_ENV] || null };
};

export const withTreeEnv = (runtime, { treeId, file, nodeId }) => ({
  ...runtime,
  env: {
    ...runtime.env,
    [TREE_ID_ENV]: treeId,
    [TREE_LEDGER_ENV]: file,
    [TREE_NODE_ENV]: nodeId,
  },
});
