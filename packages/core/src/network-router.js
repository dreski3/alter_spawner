import path from "node:path";
import { randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { readNetworkDefinition } from "./network-definition.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { applyCatalog, resolveCatalogEntry } from "./catalog.js";
import { spawnAlter } from "./engine.js";
import { createFunctionExecutor, createCapabilityExecutor } from "./harness/capability.js";
import { HARNESS_ADAPTERS, registerHarness } from "./harness/adapter.js";
import { createLayaMlxAdviser, decideRoute } from "./decision-adviser.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";

const ZERO = Object.freeze({ input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });

const response = (ok, text, extra = {}) => ({
  ok,
  text,
  tokens: { ...ZERO },
  steps: ok ? 1 : 0,
  exitCode: ok ? 0 : 1,
  killed: false,
  budget_exceeded: false,
  empty_output: false,
  sessionID: null,
  ...extra,
});

const describeCatalog = (root, cfg, component, payload) => {
  const options = createSpawnOptions({ catalog: component.catalog, name: component.id, prompt: payload, promptPrefix: "", promptSuffix: "" });
  applyCatalog(options, resolveCatalogEntry(root, cfg, component.catalog));
  if (options.nestable) throw new Error(`router child "${component.id}" must be a leaf Alter`);
  return {
    component,
    options,
    models: options.modelCandidates?.map((candidate) => candidate.model) || [options.model || cfg.default_model, options.fallbackModel].filter(Boolean),
    executors: options.modelCandidates?.map((candidate) => candidate.executor || options.executor || "opencode") || [options.executor || "opencode"],
    capabilities: options.capability?.id ? [options.capability.id] : [],
  };
};

export const runNetworkRoute = async (root, {
  routerId,
  routingSignal,
  payload,
  advisers = {},
  capabilityRegistry = null,
  createCapabilitySession = null,
  runtime: runtimeInput,
  abortSignal,
  onEvent,
} = {}) => {
  if (typeof routingSignal !== "string" || !routingSignal.trim() || routingSignal.length > 4000) throw new Error("router signal must be 1–4000 characters");
  if (typeof payload !== "string") throw new Error("router payload must be a string");
  const network = readNetworkDefinition(root);
  if (!network) throw new Error("network definition is missing");
  const router = network.components.find((component) => component.id === routerId);
  if (!router?.enabled || !router.router) throw new Error(`unknown or disabled router component: ${routerId}`);
  if (!network.ego?.enabled || !network.ego.spawn.includes(routerId)) {
    throw new Error(`principal is not allowed to spawn router "${routerId}"`);
  }
  const cfg = readConfig(root);
  const routerEntry = resolveCatalogEntry(root, cfg, router.catalog);
  const runtime = resolveRuntime(runtimeInput);
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const routerExecutor = `network-router-${runId}`;
  const functionExecutor = `network-function-${runId}`;
  const capabilityExecutor = `network-capability-${runId}`;
  const targets = new Map();
  const models = [];
  const executors = [];
  const capabilities = [];
  const catalogs = [];
  const readGrants = [];
  const writeGrants = [];
  const bashAllow = [];
  let webAccess = false;
  for (const route of router.router.routes) {
    const component = network.components.find((entry) => entry.id === route.component);
    if (component.catalog) {
      const target = describeCatalog(root, cfg, component, payload);
      targets.set(route.id, target);
      catalogs.push(component.catalog);
      models.push(...target.models);
      executors.push(...target.executors);
      capabilities.push(...target.capabilities);
      readGrants.push(...target.options.readGrants);
      writeGrants.push(...target.options.writeGrants);
      bashAllow.push(...target.options.bashAllow);
      webAccess ||= target.options.webAccess;
    } else if (component.capability) {
      if (!capabilityRegistry) throw new Error(`router route "${route.id}" requires a host capability registry`);
      const definition = capabilityRegistry.get(component.capability);
      if (!definition) throw new Error(`router route "${route.id}" references unbound capability "${component.capability}"`);
      if (definition.approval !== "never" && typeof createCapabilitySession !== "function") {
        throw new Error(`router route "${route.id}" requires a capability approval session`);
      }
      const executor = definition.approval === "never" ? functionExecutor : capabilityExecutor;
      targets.set(route.id, {
        component,
        options: createSpawnOptions({
          name: component.id,
          prompt: payload,
          executor,
          capability: { id: component.capability, input: component.input },
        }),
      });
      models.push(cfg.default_model);
      executors.push(executor);
      capabilities.push(component.capability);
    }
  }
  const adviserId = router.router.adviser;
  const adviser = advisers[adviserId] || (adviserId === "laya-mlx"
    ? { decide: (request) => createLayaMlxAdviser({ ...(cfg.decision_advisers?.[adviserId] || {}), env: runtime.env }).decide(request) }
    : null);
  if (!adviser) throw new Error(`unknown decision adviser: ${adviserId}`);
  const createdAdapters = [routerExecutor];
  if (targets.size !== router.router.routes.length) throw new Error("router has an unsupported route target");
  if ([...targets.values()].some((target) => target.component.capability)) {
    registerHarness(functionExecutor, createFunctionExecutor({ registry: capabilityRegistry }));
    createdAdapters.push(functionExecutor);
    if (typeof createCapabilitySession === "function") {
      registerHarness(capabilityExecutor, createCapabilityExecutor({ registry: capabilityRegistry, createSession: createCapabilitySession }));
      createdAdapters.push(capabilityExecutor);
    }
  }
  let decisionTrace = null;
  registerHarness(routerExecutor, {
    needsAgentHome: false,
    supportsVirtualNesting: true,
    supportsRetry: false,
    async run(home, routingSignal, { environment, depth, alterId, signal: parentSignal, timeout }) {
      const started = runtime.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, router.budget?.timeout_ms || timeout);
      if (parentSignal?.aborted) abort();
      const abortSignal = controller.signal;
      let decision;
      let decisionDuration = null;
      let child = null;
      let error = null;
      let errorCode = null;
      try {
        decision = await decideRoute({
          adviser,
          signal: routingSignal,
          instructions: router.router.instructions,
          routes: router.router.routes,
          fallbackRoute: router.router.fallback_route,
          abortSignal,
        });
        decisionDuration = runtime.now() - started;
        const target = targets.get(decision.id);
        if (!target) throw new Error(`router selected unavailable route "${decision.id}"`);
        if (abortSignal.aborted) throw new Error("router cancelled");
        try {
          onEvent?.({ type: "network.route.selected", router_id: routerId, route_id: decision.id, component_id: target.component.id });
        } catch {}
        child = await spawnAlter(root, createSpawnOptions({ ...target.options, prompt: payload }), {
          signal: abortSignal,
          onEvent,
          runtime: {
            ...runtime,
            env: { ...environment, ALTER_DEPTH: String(depth), ALTER_ID: alterId },
          },
        });
        if (!child.result.ok) {
          error = child.result.capability_error || child.result.llm_error || "selected child failed";
          errorCode = "child_failed";
        }
      } catch (cause) {
        error = cause?.message || String(cause);
        errorCode = decision ? "spawn_failed" : "decision_failed";
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abort);
      }
      decisionTrace = {
        network_id: network.id,
        network_revision: network.revision || null,
        router_id: routerId,
        adviser: adviserId,
        adviser_model: adviser.model || adviserId,
        eligible_route_ids: router.router.routes.map((route) => route.id),
        selected_route_id: decision?.id || null,
        decision_reason: decision?.reason || null,
        fallback_reason: decision?.fallbackReason || null,
        child_component_id: decision ? targets.get(decision.id)?.component.id || null : null,
        child_run_id: child ? path.basename(child.home) : null,
        child_home: child ? path.relative(root, child.home) : null,
        child_ok: child?.result?.ok ?? null,
        duration_ms: runtime.now() - started,
        decision_duration_ms: decisionDuration,
        error: errorCode,
      };
      writeJsonAtomic(path.join(home, "decision.json"), decisionTrace);
      return child?.result?.ok
        ? response(true, child.result.text)
        : response(false, "", { capability_error: error });
    },
  });
  try {
    const result = await spawnAlter(root, createSpawnOptions({
      name: `${routerId}-${runId}`,
      catalogName: router.catalog,
      description: router.description || routerEntry.manifest.description,
      prompt: routingSignal,
      model: `decision/${adviserId}`,
      executor: routerExecutor,
      nestable: true,
      allowedCatalogs: [...new Set(catalogs)],
      delegatedAuthority: {
        models: [...new Set(models)],
        executors: [...new Set(executors)],
        capabilities: [...new Set(capabilities)],
        readGrants: [...new Set(readGrants)],
        writeGrants: [...new Set(writeGrants)],
        bashAllow: [...new Set(bashAllow)],
        webAccess,
      },
    }), { signal: abortSignal, runtime, onEvent });
    return { ...result, decision: decisionTrace };
  } finally {
    for (const name of createdAdapters) HARNESS_ADAPTERS.delete(name);
  }
};
