import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fail } from "./util.js";
import { readConfig, runsDir } from "./config.js";
import { resolveCatalogEntry, applyCatalog } from "./catalog.js";
import { resolveId, scaffold } from "./scaffold.js";
import { runWithRetries } from "./retry.js";
import { writeResult, readAlterJson, resolveHome } from "./homes.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { validateOutputContract } from "./output-contract.js";
import { resolveRuntime } from "./runtime.js";
import { withoutCapabilityGrant } from "./capability-client.js";
import { getHarness } from "./harness/adapter.js";
import {
  admitTreeNode,
  releaseTreeNode,
  resolveTreeContext,
  treeGuardsEnabled,
  treeLimits,
  withTreeEnv,
} from "./tree-budget.js";

// Reserves this Alter's place in its tree — one node of the budget and one
// concurrency slot — and returns the environment its own children must inherit to
// land in the same ledger. Null when every tree limit is switched off, in which case
// no ledger is created and nothing is serialized.
const enterTree = async (root, cfg, o, runtime) => {
  const limits = treeLimits(cfg);
  if (!treeGuardsEnabled(limits)) return { handle: null, runtime };
  const { treeId, file, parentNodeId } = resolveTreeContext(root, o, runtime);
  const handle = await admitTreeNode({ file, treeId, parentNodeId, depth: o.depth, limits, runtime });
  return { handle, runtime: withTreeEnv(runtime, { treeId, file, nodeId: handle.nodeId }) };
};

// Which adapter runs this Alter. The Alter's own `executor` wins: it comes from the
// catalog manifest and is a statement about what this Alter *is* — a function node
// cannot run on a coding harness just because a caller passed one. The call-site
// `harness` is the default for Alters that do not declare one, which is every Alter
// that exists today. A caller that genuinely needs to override a declared executor
// sets `o.executor` before calling.
const resolveExecutor = (o, harness) => {
  const name = o.executor || harness || "opencode";
  const adapter = getHarness(name);
  // An adapter with no agent home has no generated agent definition, and the sandbox
  // is *expressed* in that definition's permission block — so there is nothing for a
  // grant to configure. Silently ignoring one would be the worst outcome: a manifest
  // saying `executor: "llm", web: true` reads like a web-capable node and would
  // quietly be a plain completion instead.
  if (!adapter.needsAgentHome) {
    const claimed = [
      o.nestable && "nestable",
      o.webAccess && "web",
      o.bashOnly && "bash_only",
      o.bashAllow?.length && "bash_allow",
      o.readGrants?.length && "read_grants",
      o.writeGrants?.length && "write_grants",
    ].filter(Boolean);
    if (claimed.length) {
      fail(`executor "${name}" runs without a sandbox, so it cannot be combined with ${claimed.join(", ")}.`);
    }
  }
  return { name, adapter };
};

// Every Alter runs from an environment with no capability grant in it. A grant is
// the privilege of one principal turn; an Alter beneath that turn is a sandbox and
// must not be able to spend it. See withoutCapabilityGrant for why.
const sandboxRuntime = (runtimeOverride) => {
  const runtime = resolveRuntime(runtimeOverride);
  return { ...runtime, env: withoutCapabilityGrant(runtime.env) };
};

export const resolveEffectiveModel = (o, cfg, runtime = resolveRuntime()) =>
  o.model || runtime.env.ALTER_MODEL || cfg.default_model;

const prepareSpawn = (root, cfg, o, runtime) => {
  if (o.catalog) applyCatalog(o, resolveCatalogEntry(root, cfg, o.catalog));
  validateOutputContract(o.outputContract);
  const incoming = runtime.env.ALTER_DEPTH !== undefined ? Number(runtime.env.ALTER_DEPTH) : -1;
  const depth = incoming + 1;
  const maxDepth = cfg.max_depth ?? 5;
  if (depth >= maxDepth) {
    fail(`max nesting depth (${maxDepth}) reached; refusing to spawn at depth ${depth}.`);
  }
  o.depth = depth;
  o.id = resolveId(o.name, runtime);
  o.name = o.name || o.id;
  o.model = resolveEffectiveModel(o, cfg, runtime);
  o.spawned_by = o.spawned_by || runtime.env.ALTER_ID || "root";
  return o;
};

// `o` carries the parsed spawn options (see cli's parseSpawnArgs) plus
// `mindBinPath`: the absolute path to the running `mind` CLI entrypoint,
// baked into a nestable Alter's scoped bash permission.
export const spawnAlter = async (
  root,
  o,
  { createOnly = false, harness = null, signal, onEvent, runtime: runtimeOverride } = {},
) => {
  const runtime = sandboxRuntime(runtimeOverride);
  const cfg = readConfig(root);
  prepareSpawn(root, cfg, o, runtime);
  // Resolved before scaffolding, because the adapter decides how much to scaffold —
  // and because an unknown executor should fail before anything is written to disk.
  const { name: harnessName, adapter } = resolveExecutor(o, harness);
  // Pin the resolved name onto the Alter so alter.json and result.json record what
  // actually ran rather than "unspecified", and so `mind run` on this home later
  // reaches for the same adapter.
  o.executor = harnessName;
  // `mind create` scaffolds a home without running anything, so it costs the tree no
  // node and holds no slot.
  if (createOnly) {
    const home = scaffold(root, cfg, o, runtime, { agentFiles: adapter.needsAgentHome });
    return { home, created: true, depth: o.depth, model: o.model, executor: harnessName };
  }
  // Admission comes before scaffolding: a tree that has spent its budget should say so
  // instead of leaving an orphan home behind, and a tree at its concurrency ceiling
  // should wait here rather than after doing work.
  const { handle: treeNode, runtime: treeRuntime } = await enterTree(root, cfg, o, runtime);
  let res;
  try {
    const home = scaffold(root, cfg, o, treeRuntime, { agentFiles: adapter.needsAgentHome });
    const timeout = o.timeout ?? cfg.run_timeout_ms ?? 180000;
    const effectivePrompt = [o.promptPrefix, o.prompt, o.promptSuffix].filter(Boolean).join("\n\n");
    let attempts;
    ({ res, attempts } = await runWithRetries({
      options: o,
      config: cfg,
      home,
      prompt: effectivePrompt,
      timeout,
      depth: o.depth,
      harnessName,
      signal,
      onEvent,
      pure: cfg.opencode_pure !== false,
      recordEvents: cfg.opencode_event_log === true,
      // Carries the tree id, ledger path and this node's id, so anything this Alter
      // spawns joins the same ledger instead of starting a tree of its own.
      runtime: treeRuntime,
      // An adapter with no agent home has no generated agent definition on disk, so
      // there is nothing for a model swap to rewrite.
      regenerateAgentFile: adapter.needsAgentHome,
      // A deterministic executor gets exactly one attempt; see buildAttemptPlan.
      allowRetries: adapter.supportsRetry !== false,
    }));
    const startedAt = attempts[0].started_at;
    const endedAt = attempts[attempts.length - 1].ended_at;
    const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
    const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts);
    if (o.rm) rmSync(home, { recursive: true, force: true });
    return { home, created: false, result, res };
  } finally {
    // Released even when the run throws: a slot leaked here is a slot the tree never
    // gets back, and the pid-liveness prune would not reclaim it while this process
    // is still alive.
    await releaseTreeNode(treeNode, res?.tokens?.total ?? 0);
  }
};

// Compared after resolving symlinks: `runsDir(root)` is built from the caller's root
// while an absolute `homeArg` comes from the caller verbatim, and on macOS one of those
// routinely arrives via /tmp and the other via /private/tmp. A textual prefix test would
// read that as an escape.
const realOrResolved = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const containedIn = (parent, child) => {
  const from = realOrResolved(parent);
  const to = realOrResolved(child);
  return to !== from && to.startsWith(from + path.sep);
};

// `mind run` is inside a nestable Alter's allowed command form, and resolveHome accepts
// an absolute path — so a child, whose own home is `<parent>/.alters/runs/<id>`, can name
// its parent as `../../..`. Nothing in the depth ceiling stops that: the depth here comes
// from the target's alter.json, not from ALTER_DEPTH, so re-entry never appears deeper.
//
// The damage is not the recursion, which the tree node budget bounds. It is that a re-run
// writes result.json into the target home and regenerates its alter.md — so an Alter
// reaching upward overwrites the record of a run that is still in flight, and rewrites
// the agent definition its ancestor's live session is reading.
//
// So an Alter may re-run what lives under its own `.alters/runs`, and nothing else. This
// is containment rather than a depth comparison because depth is a weak proxy for
// ancestry: a cousin's child is deeper than you and still not yours.
//
// A host has no ALTER_DEPTH, and both the CLI and the bridge address homes by absolute
// path deliberately, so the restriction applies only to callers that are themselves
// Alters.
const requireOwnDescendant = (root, home, runtime) => {
  if (runtime.env.ALTER_DEPTH === undefined) return;
  if (containedIn(runsDir(root), home)) return;
  fail(
    `refusing to run "${home}": it is outside this Alter's own runs directory. ` +
    "An Alter may re-run only homes it spawned; re-entering an ancestor or a sibling " +
    "would overwrite the result and agent definition of a run that may still be live.",
  );
};

export const runExistingAlter = async (
  root,
  homeArg,
  prompt,
  { harness = null, mindBinPath = null, signal, onEvent, runtime: runtimeOverride } = {},
) => {
  const runtime = sandboxRuntime(runtimeOverride);
  const home = resolveHome(root, homeArg);
  requireOwnDescendant(root, home, runtime);
  if (!prompt) fail("usage: mind run <home-or-id> <prompt...>");
  const aj = readAlterJson(home);
  const cfg = readConfig(root);
  const depth = aj.depth != null ? aj.depth : 0;
  const timeout = cfg.run_timeout_ms ?? 180000;
  const o = createSpawnOptions({
    id: aj.id || path.basename(home),
    name: aj.name || null,
    description: aj.description || null,
    model: aj.model || cfg.default_model,
    readGrants: aj.read_grants || [],
    writeGrants: aj.write_grants || [],
    bashAllow: aj.bash_allow || [],
    bashOnly: !!aj.bash_only,
    textOnly: !!aj.text_only,
    // Re-running a home has to use whatever executed it the first time — the home
    // was built (or deliberately not built) for that adapter.
    executor: aj.executor || null,
    capability: aj.capability || null,
    nestable: !!aj.nestable,
    webAccess: !!aj.web,
    maxTokens: aj.max_tokens ?? null,
    fallbackModel: aj.fallback_model || null,
    outputContract: aj.output_contract || null,
    catalogName: aj.catalog || null,
    depth,
    spawned_by: aj.parent_id || runtime.env.ALTER_ID || "root",
    mindBinPath,
  });
  validateOutputContract(o.outputContract);
  const { name: harnessName, adapter } = resolveExecutor(o, harness);
  // A re-run is a real process and a real model call, so it draws on the tree budget
  // like any spawn. It matters that this is not skipped: `mind run` is inside a
  // nestable Alter's allowed command form, so it would otherwise be an unmetered way
  // to keep working after the node budget was exhausted.
  const { handle: treeNode, runtime: treeRuntime } = await enterTree(root, cfg, { ...o, depth }, runtime);
  let res;
  try {
    let attempts;
    ({ res, attempts } = await runWithRetries({
      options: o,
      config: cfg,
      home,
      prompt,
      timeout,
      depth,
      harnessName,
      signal,
      onEvent,
      pure: cfg.opencode_pure !== false,
      recordEvents: cfg.opencode_event_log === true,
      runtime: treeRuntime,
      regenerateAgentFile: adapter.needsAgentHome,
      // A deterministic executor gets exactly one attempt; see buildAttemptPlan.
      allowRetries: adapter.supportsRetry !== false,
    }));
    const startedAt = attempts[0].started_at;
    const endedAt = attempts[attempts.length - 1].ended_at;
    const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
    const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts);
    return { home, result, res };
  } finally {
    await releaseTreeNode(treeNode, res?.tokens?.total ?? 0);
  }
};
