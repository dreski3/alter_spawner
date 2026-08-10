import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureAgentIdentity, kitDir, readAgentIdentity } from "./config.js";
import { withFileLock } from "./file-lock.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { iso } from "./util.js";

export const REGISTRY_SCHEMA_VERSION = 1;
export const MIND_HOME_ENV = "MIND_HOME";

// The daemon lives outside every root and holds no agent state, so it needs *some* list
// of what to tick. That list is the only reason this file exists.
//
// The split below is the whole design. `config.json` holds the **inputs** — which
// directories to look in, which roots to include regardless of location. A human writes
// it; nothing derives it. `agents.json` is a pure **index**, rebuilt by walking those
// inputs, and deleting it must cost nothing but a rescan.
//
// The temptation is to make agents.json authoritative — register on `mind init`, and
// never scan. That buys a second thing to keep in sync and a whole class of "the mind
// exists but isn't registered" bug, where the fix is always some flavour of rescan. So
// the rescan is the primary mechanism rather than the repair tool, and a missing index
// is a normal state that heals itself (see `ensureRegistry`).
export const mindHomeDir = (env = process.env) =>
  env[MIND_HOME_ENV] ? path.resolve(env[MIND_HOME_ENV]) : path.join(homeDir(env), ".mind");

const homeDir = (env) => env.HOME || homedir();

export const registryPath = (env = process.env) => path.join(mindHomeDir(env), "agents.json");
export const registryConfigPath = (env = process.env) => path.join(mindHomeDir(env), "config.json");

export const defaultWorkspaces = (env = process.env) => [path.join(homeDir(env), "minds")];

const uniquePaths = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];

// The inputs. Absent means "the default workspace and nothing else", which is what a
// first run looks like — not an error.
export const readRegistryConfig = (env = process.env) => {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(registryConfigPath(env), "utf8")) || {};
  } catch {
    raw = {};
  }
  return {
    workspaces: Array.isArray(raw.workspaces) ? uniquePaths(raw.workspaces) : defaultWorkspaces(env),
    roots: Array.isArray(raw.roots) ? uniquePaths(raw.roots) : [],
  };
};

export const writeRegistryConfig = (config, env = process.env) => {
  mkdirSync(mindHomeDir(env), { recursive: true });
  writeJsonAtomic(registryConfigPath(env), {
    workspaces: uniquePaths(config.workspaces || []),
    roots: uniquePaths(config.roots || []),
  });
};

// The inputs are edited, never derived, so these two are deliberately dumb: they add or
// drop a path and leave the rescan to the caller.
export const addRegistryInput = (target, dir, env = process.env) => {
  const config = readRegistryConfig(env);
  const key = target === "workspace" ? "workspaces" : "roots";
  const resolved = path.resolve(dir);
  const already = config[key].includes(resolved);
  if (!already) writeRegistryConfig({ ...config, [key]: [...config[key], resolved] }, env);
  return { added: !already, path: resolved, target: key };
};

export const removeRegistryInput = (dir, env = process.env) => {
  const config = readRegistryConfig(env);
  const resolved = path.resolve(dir);
  const next = {
    workspaces: config.workspaces.filter((entry) => entry !== resolved),
    roots: config.roots.filter((entry) => entry !== resolved),
  };
  const removed =
    next.workspaces.length !== config.workspaces.length || next.roots.length !== config.roots.length;
  if (removed) writeRegistryConfig(next, env);
  return { removed, path: resolved };
};

export const isMindRoot = (dir) => existsSync(path.join(kitDir(dir), "config.json"));

const SKIP_DIRS = new Set(["node_modules"]);

// Finds mind roots at or under `dir`. Descent stops at the first root on a branch: a
// mind's own subdirectories are its business, and the one thing under there that *is*
// another root — a nestable Alter's home under `.alters/runs/` — is a run artifact
// rather than a mind and must never appear in the registry. Hidden directories are
// skipped, which excludes `.alters` by construction rather than by name.
export const discoverMindRoots = (dir, { maxDepth = 3 } = {}) => {
  const found = [];
  const walk = (current, depth) => {
    if (isMindRoot(current)) {
      found.push(path.resolve(current));
      return;
    }
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable or vanished mid-walk. A scan that dies on one bad directory is worse
      // than one that reports what it could reach.
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(current, entry.name), depth + 1);
    }
  };
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(dir, 0);
  return found;
};

export const readRegistry = (env = process.env) => {
  try {
    const raw = JSON.parse(readFileSync(registryPath(env), "utf8"));
    if (!raw || typeof raw.agents !== "object" || raw.agents === null) return null;
    return { schema_version: raw.schema_version ?? REGISTRY_SCHEMA_VERSION, agents: raw.agents };
  } catch {
    return null;
  }
};

const writeRegistry = (index, env = process.env) =>
  withFileLock(registryPath(env), async () => {
    writeJsonAtomic(registryPath(env), index);
    return index;
  });

// Walks the inputs and rewrites the index from what is actually on disk. Wholesale, not
// incrementally: an entry that survives a scan only because nothing removed it is the
// stale-registry bug this design exists to avoid.
export const scanRegistry = async ({ env = process.env, runtime: runtimeOverride, adopt = true, maxDepth } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const config = readRegistryConfig(env);
  const previous = readRegistry(env)?.agents || {};
  const now = iso(runtime.now());

  const candidates = uniquePaths([
    ...config.workspaces.flatMap((workspace) => discoverMindRoots(workspace, { maxDepth })),
    ...config.roots,
  ]);

  const agents = {};
  const adopted = [];
  const conflicts = [];
  const missing = [];

  for (const root of candidates) {
    if (!isMindRoot(root)) {
      // Only reachable for an explicitly listed root — a workspace walk cannot return a
      // non-root. Worth reporting rather than dropping: someone put it in the inputs.
      missing.push(root);
      continue;
    }
    let identity = readAgentIdentity(root);
    if (!identity.agentId) {
      if (!adopt) continue;
      // A root that predates identity, or one that arrived by some means other than
      // `mind init`. Minting here is what makes a scan sufficient to register it — the
      // write is one field, in the mind's own config, and it is reported below.
      const result = ensureAgentIdentity(root, { runtime });
      identity = { agentId: result.agentId, name: result.name, memoryProjectId: result.memoryProjectId };
      adopted.push({ root, agentId: identity.agentId, name: identity.name });
    }
    const existing = agents[identity.agentId];
    if (existing) {
      // Two roots claiming one identity — almost always `cp -r` of a mind. Keyed by
      // agent_id, the index would silently keep whichever was scanned last, so the
      // duplicate is reported and the first one wins deterministically.
      conflicts.push({ agentId: identity.agentId, kept: existing.root, ignored: root });
      continue;
    }
    agents[identity.agentId] = {
      root,
      name: identity.name || path.basename(root),
      // Preserved across rescans on purpose: this is the daemon's liveness signal, and
      // resetting it on every scan would make it mean "when did I last scan". It is also
      // the one field a rebuild cannot recover, which is why nothing may depend on it
      // for correctness — only for reporting.
      last_seen: previous[identity.agentId]?.last_seen || now,
    };
  }

  const index = { schema_version: REGISTRY_SCHEMA_VERSION, agents };
  await writeRegistry(index, env);
  return { index, adopted, conflicts, missing, workspaces: config.workspaces, roots: config.roots };
};

// Deleting agents.json is supposed to cost nothing but a rescan, so a missing index
// triggers one rather than failing. Callers that specifically want to know whether the
// index existed should use `readRegistry`.
export const ensureRegistry = async ({ env = process.env, runtime } = {}) => {
  const existing = readRegistry(env);
  if (existing) return existing;
  return (await scanRegistry({ env, runtime })).index;
};

export const touchMind = async (agentId, { env = process.env, runtime: runtimeOverride } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  return withFileLock(registryPath(env), async () => {
    const index = readRegistry(env);
    if (!index?.agents?.[agentId]) return null;
    index.agents[agentId] = { ...index.agents[agentId], last_seen: iso(runtime.now()) };
    writeJsonAtomic(registryPath(env), index);
    return index.agents[agentId];
  });
};

// Resolves an agent_id or a name to a root. Names are allowed to collide — they are the
// mutable, human half of identity — so an ambiguous one is an error rather than a guess.
// A hit whose root has since disappeared triggers one rescan before giving up, which is
// the same self-healing rule as `ensureRegistry`.
export const resolveMind = async (needle, { env = process.env, runtime, rescanned = false } = {}) => {
  if (!needle) throw new Error("resolveMind needs an agent_id or a name");
  const index = await ensureRegistry({ env, runtime });
  const entries = Object.entries(index.agents);

  const byId = entries.find(([agentId]) => agentId === needle);
  const matches = byId ? [byId] : entries.filter(([, entry]) => entry.name === needle);

  if (matches.length > 1) {
    const roots = matches.map(([, entry]) => entry.root).join(", ");
    throw new Error(`"${needle}" names more than one mind (${roots}) — use its agent_id`);
  }
  if (matches.length === 1) {
    const [agentId, entry] = matches[0];
    if (isMindRoot(entry.root)) return { agentId, ...entry };
  }
  if (rescanned) throw new Error(`no mind named "${needle}" (run \`mind agents scan\`)`);
  await scanRegistry({ env, runtime });
  return resolveMind(needle, { env, runtime, rescanned: true });
};

export const listMinds = async ({ env = process.env, runtime } = {}) => {
  const index = await ensureRegistry({ env, runtime });
  return Object.entries(index.agents)
    .map(([agentId, entry]) => ({ agentId, ...entry }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId));
};
