import { realpathSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fail } from "./util.js";
import { readConfig, runsDir } from "./config.js";
import { resolveCatalogEntry, applyCatalog } from "./catalog.js";
import { resolveId, scaffold } from "./scaffold.js";
import { buildAttemptPlan, runWithRetries } from "./retry.js";
import { writeResult, readAlterJson, resolveHome } from "./homes.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { validateOutputContract } from "./output-contract.js";
import { planRequest, validateRoutingPolicy } from "./request-planner.js";
import { createLayaMlxAdviser, decideRoute } from "./decision-adviser.js";
import { resolveRuntime } from "./runtime.js";
import { withoutCapabilityGrant } from "./capability-client.js";
import { getHarness } from "./harness/adapter.js";
import { validateDirectImageModels, validateImageFiles, validateImageModels } from "./image-input.js";
import { authorityMaxDepth, delegateAuthority } from "./authority.js";
import { measureRunCall } from "./run-measurement.js";
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
  if (!treeGuardsEnabled(limits)) {
    const treeId = runtime.env.ALTER_TREE || `tree_${runtime.randomId(8)}`;
    return { handle: null, runtime: { ...runtime, env: { ...runtime.env, ALTER_TREE: treeId } } };
  }
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
      o.nestable && !adapter.supportsVirtualNesting && "nestable",
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

const validateExecutorOptions = (name, adapter, o, models) => {
  try {
    adapter.validateOptions?.(o, { models });
  } catch (error) {
    fail(error?.message || `executor "${name}" rejected this Alter configuration.`);
  }
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

const validateSpawnModelCandidates = (o) => {
  if (o.modelCandidates != null) {
    if (!Array.isArray(o.modelCandidates) || o.modelCandidates.length === 0) {
      fail("modelCandidates must be a non-empty array when provided.");
    }
    if (o.fallbackModel) fail("modelCandidates cannot be combined with fallbackModel.");
    const ids = new Set();
    for (const candidate of o.modelCandidates) {
      const unsupported = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? Object.keys(candidate).find((key) => !["id", "model", "executor"].includes(key))
        : null;
      if (unsupported) fail(`modelCandidates entry field "${unsupported}" is not supported.`);
      if (
        !candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id !== candidate.id.trim() ||
        typeof candidate.model !== "string" || !candidate.model.trim() || candidate.model !== candidate.model.trim() ||
        candidate.model.indexOf("/") <= 0 || candidate.model.indexOf("/") === candidate.model.length - 1
      ) {
        fail("each modelCandidates entry must have a non-empty id and a provider/model reference.");
      }
      if (ids.has(candidate.id)) fail(`duplicate model candidate id "${candidate.id}".`);
      if (candidate.executor != null && !["llm", "opencode", "codex", "grok"].includes(candidate.executor)) {
        fail("modelCandidates executor must be llm, opencode, codex, or grok.");
      }
      ids.add(candidate.id);
    }
    if (o.model && o.model !== o.modelCandidates[0].model) {
      fail("model must match the first modelCandidates entry when both are provided.");
    }
    o.model = o.modelCandidates[0].model;
  }
};

const prepareSpawn = (root, cfg, o, runtime) => {
  if (o.catalog) applyCatalog(o, resolveCatalogEntry(root, cfg, o.catalog));
  validateSpawnModelCandidates(o);
  if (o.opencodeVariant != null && (typeof o.opencodeVariant !== "string" || !o.opencodeVariant.trim())) {
    fail("variant must be a non-empty model variant name.");
  }
  validateRoutingPolicy(o.routing);
  if (o.routing != null && o.modelCandidates == null) fail("routing requires modelCandidates.");
  validateOutputContract(o.outputContract);
  const incoming = runtime.env.ALTER_DEPTH !== undefined ? Number(runtime.env.ALTER_DEPTH) : -1;
  const depth = incoming + 1;
  const maxDepth = authorityMaxDepth(cfg, runtime);
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

const prepareImages = (root, o, runtime, { createOnly = false } = {}) => {
  if (!o.images?.length) return;
  if (createOnly) fail("images are invocation inputs and cannot be supplied to create-only Alters.");
  const images = validateImageFiles(root, o.images, {
    readGrants: [...o.readGrants, ...o.writeGrants],
    environment: runtime.env,
  });
  o.images = images.map((image) => image.path);
  o.imageMetadata = images.map((image) => image.metadata);
};

const prepareExecution = async (o, cfg, runtime, harness, prompt, { advisers = {}, signal, useAdviser = true } = {}) => {
  const defaultExecutor = o.executor || harness || "opencode";
  o.baseExecutor = defaultExecutor;
  if (o.modelCandidates?.length) {
    const plannerStarted = performance.now();
    const route = planRequest({ options: o, config: cfg, prompt, defaultExecutor, environment: runtime.env });
    const plannerDuration = performance.now() - plannerStarted;
    let candidates = route.candidates;
    let adviserTrace = null;
    if (useAdviser && o.routing?.adviser) {
      const adviserStarted = performance.now();
      const policy = o.routing.adviser;
      const adviser = advisers[policy.id] || (policy.id === "laya-mlx"
        ? { decide: (request) => createLayaMlxAdviser({ ...(cfg.decision_advisers?.[policy.id] || {}), env: runtime.env }).decide(request) }
        : { decide: async () => { throw new Error(`unknown decision adviser: ${policy.id}`); } });
      const decision = await decideRoute({
        adviser,
        signal: prompt,
        instructions: policy.instructions,
        routes: candidates.map((candidate) => ({ id: candidate.id, description: policy.criteria[candidate.id] })),
        fallbackRoute: candidates[0].id,
        abortSignal: signal,
      });
      candidates = [candidates.find((candidate) => candidate.id === decision.id), ...candidates.filter((candidate) => candidate.id !== decision.id)];
      adviserTrace = {
        id: policy.id,
        decision_reason: decision.reason,
        fallback_reason: decision.fallbackReason,
        outcome: decision.adviserOutcome,
        duration_ms: performance.now() - adviserStarted,
      };
    }
    o.plannedCandidates = candidates;
    o.routePlan = {
      strategy: route.strategy,
      estimated_input_tokens: route.estimated_input_tokens,
      selected_candidate_id: candidates[0].id,
      planner_duration_ms: plannerDuration,
      assessed: route.assessed,
      ...(adviserTrace ? { adviser: adviserTrace } : {}),
    };
    o.model = candidates[0].model;
    o.executor = candidates[0].executor;
  }
  const { name: harnessName, adapter } = resolveExecutor(o, harness);
  const attemptPlan = buildAttemptPlan(o, cfg, runtime, { allowRetries: adapter.supportsRetry !== false });
  if (o.opencodeVariant && attemptPlan.some((attempt) => (attempt.executor || harnessName) !== "opencode")) {
    fail("--variant is supported only by the opencode executor.");
  }
  const byExecutor = new Map();
  for (const attempt of attemptPlan) {
    const name = attempt.executor || harnessName;
    if (!byExecutor.has(name)) byExecutor.set(name, []);
    byExecutor.get(name).push(attempt.model);
  }
  for (const [name, models] of byExecutor) {
    const candidateAdapter = getHarness(name);
    if (o.images?.length && !candidateAdapter.supportsImages) fail(`executor "${name}" does not support image inputs.`);
    validateExecutorOptions(name, candidateAdapter, o, models);
    if (o.images?.length && name === "llm") validateDirectImageModels(models, cfg.providers, runtime.env);
    if (o.images?.length && name === "opencode" && !o.opencodeProvider) validateImageModels(models, runtime.env);
  }
  const configuredExecutors = o.modelCandidates?.map((candidate) => candidate.executor || defaultExecutor) || [...byExecutor.keys()];
  const configuredAdapters = configuredExecutors.map((name) => getHarness(name));
  const agentHomeKinds = [...new Set(configuredAdapters.filter((item) => item.needsAgentHome).map((item) => item.agentHomeKind))];
  const regenerateAgentFile = configuredAdapters.some((item) => item.needsAgentHome && item.agentHomeKind === "opencode" && item.regeneratesAgentFile);
  return { harnessName, adapter, agentHomeKinds, regenerateAgentFile, attemptPlan };
};

// `o` carries the parsed spawn options (see cli's parseSpawnArgs) plus
// `mindBinPath`: the absolute path to the running `mind` CLI entrypoint,
// baked into a nestable Alter's scoped bash permission.
const spawnAlterInternal = async (
  root,
  o,
  { createOnly = false, harness = null, signal, onEvent, runtime: runtimeOverride, advisers = {} } = {},
  markHome = () => {},
) => {
  const wallStarted = performance.now();
  const runtime = sandboxRuntime(runtimeOverride);
  const wallStartedAt = new Date(runtime.now()).toISOString();
  const cfg = readConfig(root);
  prepareSpawn(root, cfg, o, runtime);
  prepareImages(root, o, runtime, { createOnly });
  const effectivePrompt = [o.promptPrefix, o.prompt, o.promptSuffix].filter(Boolean).join("\n\n");
  const planningStarted = performance.now();
  const { harnessName, adapter, agentHomeKinds, regenerateAgentFile, attemptPlan } = await prepareExecution(o, cfg, runtime, harness, effectivePrompt, { advisers, signal, useAdviser: !createOnly });
  const planningMs = performance.now() - planningStarted;
  // Pin the resolved name onto the Alter so alter.json and result.json record what
  // actually ran rather than "unspecified", and so `mind run` on this home later
  // reaches for the same adapter.
  o.executor = harnessName;
  const attemptModels = attemptPlan.map((attempt) => attempt.model);
  const attemptExecutors = attemptPlan.map((attempt) => attempt.executor || harnessName);
  const authorityRuntime = delegateAuthority(o, cfg, runtime, { attemptModels, attemptExecutors });
  // `mind create` scaffolds a home without running anything, so it costs the tree no
  // node and holds no slot.
  if (createOnly) {
    const home = scaffold(root, cfg, o, authorityRuntime, {
      agentFiles: agentHomeKinds.length > 0,
      agentHomeKinds,
    });
    return { home, created: true, depth: o.depth, model: o.model, executor: harnessName };
  }
  // Admission comes before scaffolding: a tree that has spent its budget should say so
  // instead of leaving an orphan home behind, and a tree at its concurrency ceiling
  // should wait here rather than after doing work.
  const admissionStarted = performance.now();
  const { handle: treeNode, runtime: treeRuntime } = await enterTree(root, cfg, o, authorityRuntime);
  const admissionMs = performance.now() - admissionStarted;
  o.treeId = treeRuntime.env.ALTER_TREE || null;
  let res;
  let attempts;
  try {
    const scaffoldStarted = performance.now();
    const home = scaffold(root, cfg, o, treeRuntime, {
      agentFiles: agentHomeKinds.length > 0,
      agentHomeKinds,
    });
    markHome(home);
    const scaffoldMs = performance.now() - scaffoldStarted;
    const timeout = o.timeout ?? cfg.run_timeout_ms ?? 180000;
    const executionStarted = performance.now();
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
      regenerateAgentFile,
      // A deterministic executor gets exactly one attempt; see buildAttemptPlan.
      allowRetries: adapter.supportsRetry !== false,
    }));
    const executionMs = performance.now() - executionStarted;
    const startedAt = attempts[0].started_at;
    const endedAt = attempts[attempts.length - 1].ended_at;
    const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
    const wallMs = performance.now() - wallStarted;
    const timing = {
      wall_started_at: wallStartedAt,
      wall_ended_at: new Date(runtime.now()).toISOString(),
      wall_duration_ms: wallMs,
      planning_ms: planningMs,
      admission_ms: admissionMs,
      queue_ms: treeNode?.queueWaitMs ?? 0,
      scaffold_ms: scaffoldMs,
      execution_ms: executionMs,
      attempts_ms: attempts.reduce((sum, attempt) => sum + (attempt.elapsed_ms ?? attempt.duration_ms), 0),
      other_ms: Math.max(0, wallMs - planningMs - admissionMs - scaffoldMs - executionMs),
    };
    const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts, timing);
    if (o.rm) rmSync(home, { recursive: true, force: true });
    return { home, created: false, result, res };
  } finally {
    // Released even when the run throws: a slot leaked here is a slot the tree never
    // gets back, and the pid-liveness prune would not reclaim it while this process
    // is still alive.
    await releaseTreeNode(treeNode, attempts?.reduce((sum, attempt) => sum + (attempt.tokens?.total || 0), 0) ?? res?.tokens?.total ?? 0);
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

const runExistingAlterInternal = async (
  root,
  homeArg,
  prompt,
  { harness = null, mindBinPath = null, images = [], signal, onEvent, runtime: runtimeOverride, advisers = {} } = {},
  markHome = () => {},
) => {
  const wallStarted = performance.now();
  const runtime = sandboxRuntime(runtimeOverride);
  const wallStartedAt = new Date(runtime.now()).toISOString();
  const home = resolveHome(root, homeArg);
  markHome(home);
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
    images,
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
    modelCandidates: aj.model_candidates || null,
    routing: aj.routing || null,
    opencodeProvider: aj.opencode_provider || null,
    opencodeVariant: aj.opencode_variant || null,
    outputContract: aj.output_contract || null,
    catalogName: aj.catalog || null,
    depth,
    spawned_by: aj.parent_id || runtime.env.ALTER_ID || "root",
    mindBinPath,
  });
  validateSpawnModelCandidates(o);
  validateRoutingPolicy(o.routing);
  if (o.routing != null && o.modelCandidates == null) fail("routing requires modelCandidates.");
  validateOutputContract(o.outputContract);
  prepareImages(root, o, runtime);
  const planningStarted = performance.now();
  const { harnessName, adapter, regenerateAgentFile, attemptPlan } = await prepareExecution(o, cfg, runtime, harness, prompt, { advisers, signal });
  const planningMs = performance.now() - planningStarted;
  o.executor = harnessName;
  const attemptModels = attemptPlan.map((attempt) => attempt.model);
  const attemptExecutors = attemptPlan.map((attempt) => attempt.executor || harnessName);
  const authorityRuntime = delegateAuthority(o, cfg, runtime, { attemptModels, attemptExecutors });
  // A re-run is a real process and a real model call, so it draws on the tree budget
  // like any spawn. It matters that this is not skipped: `mind run` is inside a
  // nestable Alter's allowed command form, so it would otherwise be an unmetered way
  // to keep working after the node budget was exhausted.
  const admissionStarted = performance.now();
  const { handle: treeNode, runtime: treeRuntime } = await enterTree(root, cfg, { ...o, depth }, authorityRuntime);
  const admissionMs = performance.now() - admissionStarted;
  o.treeId = treeRuntime.env.ALTER_TREE || null;
  let res;
  let attempts;
  try {
    const executionStarted = performance.now();
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
      regenerateAgentFile,
      // A deterministic executor gets exactly one attempt; see buildAttemptPlan.
      allowRetries: adapter.supportsRetry !== false,
    }));
    const executionMs = performance.now() - executionStarted;
    const startedAt = attempts[0].started_at;
    const endedAt = attempts[attempts.length - 1].ended_at;
    const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
    const wallMs = performance.now() - wallStarted;
    const timing = {
      wall_started_at: wallStartedAt,
      wall_ended_at: new Date(runtime.now()).toISOString(),
      wall_duration_ms: wallMs,
      planning_ms: planningMs,
      admission_ms: admissionMs,
      queue_ms: treeNode?.queueWaitMs ?? 0,
      scaffold_ms: 0,
      execution_ms: executionMs,
      attempts_ms: attempts.reduce((sum, attempt) => sum + (attempt.elapsed_ms ?? attempt.duration_ms), 0),
      other_ms: Math.max(0, wallMs - planningMs - admissionMs - executionMs),
    };
    const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts, timing);
    return { home, result, res };
  } finally {
    await releaseTreeNode(treeNode, attempts?.reduce((sum, attempt) => sum + (attempt.tokens?.total || 0), 0) ?? res?.tokens?.total ?? 0);
  }
};

export const spawnAlter = (root, options, settings = {}) =>
  measureRunCall(root, "spawn", settings.onEvent, (markHome) => spawnAlterInternal(root, options, settings, markHome));

export const runExistingAlter = (root, homeArg, prompt, settings = {}) =>
  measureRunCall(root, "run", settings.onEvent, (markHome) => runExistingAlterInternal(root, homeArg, prompt, settings, markHome));
