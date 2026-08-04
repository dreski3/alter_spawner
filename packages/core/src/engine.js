import { rmSync } from "node:fs";
import path from "node:path";
import { fail } from "./util.js";
import { readConfig } from "./config.js";
import { resolveCatalogEntry, applyCatalog } from "./catalog.js";
import { resolveId, scaffold } from "./scaffold.js";
import { runWithRetries } from "./retry.js";
import { writeResult, readAlterJson, resolveHome } from "./homes.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { validateOutputContract } from "./output-contract.js";
import { resolveRuntime } from "./runtime.js";
import { withoutCapabilityGrant } from "./capability-client.js";

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
  { createOnly = false, harness = "opencode", signal, onEvent, runtime: runtimeOverride } = {},
) => {
  const runtime = sandboxRuntime(runtimeOverride);
  const cfg = readConfig(root);
  prepareSpawn(root, cfg, o, runtime);
  const home = scaffold(root, cfg, o, runtime);
  if (createOnly) {
    return { home, created: true, depth: o.depth, model: o.model };
  }
  const timeout = o.timeout ?? cfg.run_timeout_ms ?? 180000;
  const effectivePrompt = [o.promptPrefix, o.prompt, o.promptSuffix].filter(Boolean).join("\n\n");
  const { res, attempts } = await runWithRetries({
    options: o,
    config: cfg,
    home,
    prompt: effectivePrompt,
    timeout,
    depth: o.depth,
    harnessName: harness,
    signal,
    onEvent,
    pure: cfg.opencode_pure !== false,
    recordEvents: cfg.opencode_event_log === true,
    runtime,
  });
  const startedAt = attempts[0].started_at;
  const endedAt = attempts[attempts.length - 1].ended_at;
  const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
  const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts);
  if (o.rm) rmSync(home, { recursive: true, force: true });
  return { home, created: false, result, res };
};

export const runExistingAlter = async (
  root,
  homeArg,
  prompt,
  { harness = "opencode", mindBinPath = null, signal, onEvent, runtime: runtimeOverride } = {},
) => {
  const runtime = sandboxRuntime(runtimeOverride);
  const home = resolveHome(root, homeArg);
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
  const { res, attempts } = await runWithRetries({
    options: o,
    config: cfg,
    home,
    prompt,
    timeout,
    depth,
    harnessName: harness,
    signal,
    onEvent,
    pure: cfg.opencode_pure !== false,
    recordEvents: cfg.opencode_event_log === true,
    runtime,
  });
  const startedAt = attempts[0].started_at;
  const endedAt = attempts[attempts.length - 1].ended_at;
  const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
  const result = writeResult(root, home, o, res, startedAt, endedAt, totalDuration, attempts);
  return { home, result, res };
};
