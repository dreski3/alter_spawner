import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  normalizeJsonSchema,
  normalizeJsonValue,
  validateStructuredInput,
} from "./structured-data.js";

const approvalDecisions = new Set(["allow-once", "allow-run", "always-catalog", "deny"]);
export const VALID_APPROVAL_DECISIONS = Object.freeze({
  get size() { return approvalDecisions.size; },
  has: (decision) => approvalDecisions.has(decision),
  values: () => approvalDecisions.values(),
  keys: () => approvalDecisions.keys(),
  entries: () => approvalDecisions.entries(),
  forEach: (callback, thisArg) => approvalDecisions.forEach((decision) => {
    callback.call(thisArg, decision, decision, VALID_APPROVAL_DECISIONS);
  }),
  [Symbol.iterator]: () => approvalDecisions[Symbol.iterator](),
});

const publicCapability = (definition) => ({
  id: definition.id,
  name: definition.name,
  description: definition.description,
  risk: definition.risk,
  approval: definition.approval,
});

const publicApproval = (approval) => approval ? {
  id: approval.id,
  capabilityId: approval.capabilityId,
  capabilityName: approval.capabilityName,
  description: approval.description,
  reason: approval.reason,
  risk: approval.risk,
  commandPreview: approval.commandPreview,
  inputPreview: approval.inputPreview,
  executionDigest: approval.executionDigest,
  executorVersion: approval.executorVersion,
  allowedDecisions: approval.allowedDecisions,
  requestedAt: approval.requestedAt,
} : null;

const normalizeDefinition = (definition) => {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("capability definition must be an object");
  }
  if (typeof definition.id !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(definition.id)) {
    throw new Error("capability id must contain lowercase letters, numbers, dots, underscores, or hyphens");
  }
  if (!definition.name || !definition.description) throw new Error(`capability ${definition.id} requires a name and description`);
  if (definition.approval !== undefined && definition.approval !== "always" && definition.approval !== "never") {
    throw new Error(`capability ${definition.id} approval must be always or never`);
  }
  const allowedDecisions = definition.allowedDecisions || [...approvalDecisions];
  if (!Array.isArray(allowedDecisions) || allowedDecisions.length === 0 || allowedDecisions.some((decision) => !approvalDecisions.has(decision))) {
    throw new Error(`capability ${definition.id} allowed decisions are invalid`);
  }
  if (!allowedDecisions.includes("deny")) throw new Error(`capability ${definition.id} must allow denial`);
  const hasHandler = typeof definition.handler === "function";
  const hasExecutors = definition.executors && Object.keys(definition.executors).length > 0;
  if (hasHandler === Boolean(hasExecutors)) throw new Error(`capability ${definition.id} requires exactly one trusted execution strategy`);
  if (hasHandler && !definition.inputSchema) throw new Error(`structured capability ${definition.id} requires an input schema`);
  if (!hasHandler && definition.inputSchema !== undefined) throw new Error(`command capability ${definition.id} cannot declare structured input`);
  if (definition.approvalPreview !== undefined && typeof definition.approvalPreview !== "function") {
    throw new Error(`capability ${definition.id} approval preview must be a function`);
  }
  const executorVersion = String(definition.executorVersion || "1");
  if (!executorVersion || executorVersion.length > 100) throw new Error(`capability ${definition.id} executor version is invalid`);
  const executors = Object.fromEntries(Object.entries(definition.executors || {}).map(([platform, executor]) => {
    if (!executor || typeof executor.file !== "string" || !path.isAbsolute(executor.file)) {
      throw new Error(`capability ${definition.id} executor for ${platform} requires an absolute file path`);
    }
    if (!Array.isArray(executor.args) || executor.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`capability ${definition.id} executor for ${platform} requires a fixed argument vector`);
    }
    return [platform, Object.freeze({ file: executor.file, args: Object.freeze([...executor.args]) })];
  }));
  return Object.freeze({
    id: definition.id,
    name: String(definition.name),
    description: String(definition.description),
    risk: definition.risk || "medium",
    approval: definition.approval || "always",
    timeoutMs: Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0 ? definition.timeoutMs : 15000,
    maxOutputBytes: Number.isFinite(definition.maxOutputBytes) && definition.maxOutputBytes > 0 ? definition.maxOutputBytes : 256000,
    executorVersion,
    allowedDecisions: Object.freeze([...new Set(allowedDecisions)]),
    inputSchema: definition.inputSchema ? normalizeJsonSchema(definition.inputSchema, `capability ${definition.id} input schema`) : null,
    approvalPreview: definition.approvalPreview || null,
    handler: hasHandler ? definition.handler : null,
    executors: Object.freeze(executors),
  });
};

const executeDefinition = (definition, { signal, platform = process.platform } = {}) => new Promise((resolve, reject) => {
  const executor = definition.executors[platform];
  if (!executor) {
    reject(new Error(`${definition.name} is unavailable on ${platform}.`));
    return;
  }
  const child = spawn(executor.file, executor.args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let settled = false;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    callback();
  };
  const collect = (target) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > definition.maxOutputBytes) {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${definition.name} exceeded its output limit.`)));
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  const abort = () => {
    child.kill("SIGTERM");
    finish(() => reject(new Error("Capability execution cancelled.")));
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(() => reject(new Error(`${definition.name} timed out.`)));
  }, definition.timeoutMs);
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  child.on("error", (error) => finish(() => reject(error)));
  child.on("close", (code, childSignal) => finish(() => resolve({
    ok: code === 0,
    exitCode: code,
    signal: childSignal,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    value: null,
    outputBytes,
  })));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
});

const executeHandler = async (definition, invocation, { signal } = {}) => {
  if (signal?.aborted) throw new Error("Capability execution cancelled.");
  const value = normalizeJsonValue(await definition.handler({ input: invocation.input, signal }), "capability result");
  const outputBytes = Buffer.byteLength(canonicalJson(value));
  if (outputBytes > definition.maxOutputBytes) throw new Error(`${definition.name} exceeded its output limit.`);
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    value,
    outputBytes,
  };
};

export const createCapabilityRegistry = ({ definitions = [], catalogCapabilities = {} } = {}) => {
  const entries = Array.isArray(definitions) ? definitions : Object.values(definitions);
  const registered = new Map();
  for (const raw of entries) {
    const definition = normalizeDefinition(raw);
    if (registered.has(definition.id)) throw new Error(`capability is already registered: ${definition.id}`);
    registered.set(definition.id, definition);
  }
  const bindings = Object.freeze(Object.fromEntries(Object.entries(catalogCapabilities).map(([catalogId, ids]) => {
    if (!Array.isArray(ids)) throw new Error(`catalog capability binding for ${catalogId} must be an array`);
    for (const id of ids) if (!registered.has(id)) throw new Error(`catalog ${catalogId} references unknown capability ${id}`);
    return [catalogId, Object.freeze([...new Set(ids)])];
  })));
  const requireCapability = (id) => {
    const definition = registered.get(id);
    if (!definition) throw new Error(`unknown capability: ${id}`);
    return definition;
  };
  const preparedInvocations = new WeakSet();
  const prepare = (id, { input, platform = process.platform } = {}) => {
    const definition = requireCapability(id);
    let normalizedInput = null;
    if (definition.inputSchema) normalizedInput = validateStructuredInput(definition.inputSchema, input);
    else if (input !== undefined) throw new Error(`capability ${id} does not accept structured input`);
    const executor = definition.handler ? { type: "handler" } : {
      type: "command",
      platform,
      file: definition.executors[platform]?.file || null,
      args: definition.executors[platform]?.args || null,
    };
    const executionDigest = createHash("sha256").update(canonicalJson({
      capabilityId: id,
      executorVersion: definition.executorVersion,
      executor,
      input: normalizedInput,
    })).digest("hex");
    const inputPreview = definition.inputSchema
      ? normalizeJsonValue(definition.approvalPreview ? definition.approvalPreview(normalizedInput) : normalizedInput, "approval preview")
      : null;
    const commandExecutor = definition.executors[platform];
    const invocation = Object.freeze({
      capabilityId: id,
      platform,
      input: normalizedInput,
      inputPreview,
      executionDigest,
      executorVersion: definition.executorVersion,
      commandPreview: definition.handler
        ? definition.name
        : commandExecutor
          ? [commandExecutor.file, ...commandExecutor.args].join(" ")
          : `Unavailable on ${platform}`,
    });
    preparedInvocations.add(invocation);
    return invocation;
  };
  const executePrepared = async (invocation, options = {}) => {
    if (!invocation || !preparedInvocations.has(invocation)) throw new Error("capability invocation was not prepared by this registry");
    const definition = requireCapability(invocation.capabilityId);
    return definition.handler
      ? executeHandler(definition, invocation, options)
      : executeDefinition(definition, { signal: options.signal, platform: invocation.platform });
  };
  return Object.freeze({
    get: (id) => registered.get(id) || null,
    forCatalog: (catalogId) => (bindings[catalogId] || []).map(requireCapability),
    listPublic: () => [...registered.values()].map(publicCapability),
    commandPreview: (id, platform = process.platform) => {
      const definition = requireCapability(id);
      if (definition.handler) return definition.name;
      const executor = definition.executors[platform];
      return executor ? [executor.file, ...executor.args].join(" ") : `Unavailable on ${platform}`;
    },
    prepare,
    executePrepared,
    execute: async (id, options = {}) => executePrepared(prepare(id, options), options),
  });
};

export class CapabilityDeniedError extends Error {
  constructor(capability) {
    super(`${capability.name} was denied. No trusted capability was executed.`);
    this.name = "CapabilityDeniedError";
    this.capabilityId = capability.id;
  }
}

export const createCapabilityApprovalSession = ({
  registry,
  catalogId,
  signal,
  isPersistentlyApproved = () => false,
  persistApproval = () => {},
  audit = () => {},
  onEvent = () => {},
  createId = () => `approval_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
} = {}) => {
  if (
    !registry ||
    typeof registry.get !== "function" ||
    typeof registry.prepare !== "function" ||
    typeof registry.executePrepared !== "function"
  ) {
    throw new Error("capability approval session requires a capability registry");
  }
  if (typeof catalogId !== "string" || !catalogId) throw new Error("capability approval session requires a catalog id");
  const runGrants = new Set();
  let pending = null;

  const emit = (type, detail = {}) => {
    try {
      onEvent({ type, ...detail });
    } catch {}
  };
  const authorizePrepared = async (invocation, { reason } = {}) => {
    const capabilityId = invocation.capabilityId;
    const definition = registry.get(capabilityId);
    if (signal?.aborted) throw new Error("Run cancelled while waiting for capability approval.");
    if (pending) throw new Error("another capability approval is already pending");
    if (definition.approval !== "always") {
      emit("capability.auto_approved", { capabilityId, executionDigest: invocation.executionDigest, decision: "not-required" });
      return { decision: "not-required" };
    }
    if (definition.allowedDecisions.includes("allow-run") && runGrants.has(capabilityId)) {
      emit("capability.auto_approved", { capabilityId, executionDigest: invocation.executionDigest, decision: "allow-run" });
      return { decision: "allow-run" };
    }
    if (
      definition.allowedDecisions.includes("always-catalog") &&
      isPersistentlyApproved({ catalogId, capabilityId, executionDigest: invocation.executionDigest })
    ) {
      emit("capability.auto_approved", { capabilityId, executionDigest: invocation.executionDigest, decision: "always-catalog" });
      return { decision: "always-catalog" };
    }
    return new Promise((resolve, reject) => {
      const approval = {
        id: createId(),
        capabilityId,
        capabilityName: definition.name,
        description: definition.description,
        reason: reason || `${catalogId} requires this capability.`,
        risk: definition.risk,
        commandPreview: invocation.commandPreview,
        inputPreview: invocation.inputPreview,
        executionDigest: invocation.executionDigest,
        executorVersion: invocation.executorVersion,
        allowedDecisions: definition.allowedDecisions,
        invocation,
        requestedAt: now(),
        resolve,
        reject,
      };
      const abort = () => {
        if (pending?.id !== approval.id) return;
        pending = null;
        reject(new Error("Run cancelled while waiting for capability approval."));
      };
      approval.cleanup = () => signal?.removeEventListener("abort", abort);
      pending = approval;
      signal?.addEventListener("abort", abort, { once: true });
      emit("capability.approval_required", { approval: publicApproval(approval) });
    });
  };
  const authorize = async (capabilityId, options = {}) =>
    authorizePrepared(registry.prepare(capabilityId, options), options);

  const decide = async (approvalId, decision) => {
    const approval = pending;
    if (!approval || approval.id !== approvalId) throw new Error("approval request is no longer pending");
    if (!approvalDecisions.has(decision)) throw new Error("invalid approval decision");
    if (!approval.allowedDecisions.includes(decision)) throw new Error("approval decision is not allowed for this capability");
    if (decision === "always-catalog") {
      await persistApproval({
        catalogId,
        capabilityId: approval.capabilityId,
        executionDigest: approval.executionDigest,
        decision,
        approval: publicApproval(approval),
      });
    }
    await audit({
      catalogId,
      capabilityId: approval.capabilityId,
      executionDigest: approval.executionDigest,
      decision,
      approval: publicApproval(approval),
    });
    approval.cleanup?.();
    pending = null;
    if (decision === "allow-run") runGrants.add(approval.capabilityId);
    if (decision === "deny") emit("capability.denied", {
      capabilityId: approval.capabilityId,
      executionDigest: approval.executionDigest,
      decision,
    });
    else emit("capability.approved", {
      capabilityId: approval.capabilityId,
      executionDigest: approval.executionDigest,
      decision,
    });
    approval.resolve({ decision });
    return { decision };
  };

  const execute = async (capabilityId, options = {}) => {
    const definition = registry.get(capabilityId);
    if (!definition) throw new Error(`unknown capability: ${capabilityId}`);
    const invocation = registry.prepare(capabilityId, options);
    const { decision } = await authorizePrepared(invocation, options);
    if (decision === "deny") throw new CapabilityDeniedError(definition);
    emit("capability.execution_started", {
      capabilityId,
      commandPreview: invocation.commandPreview,
      executionDigest: invocation.executionDigest,
    });
    const startedAt = clock();
    try {
      const result = await registry.executePrepared(invocation, { signal });
      const durationMs = clock() - startedAt;
      if (result.ok) {
        emit("capability.execution_completed", {
          capabilityId,
          exitCode: result.exitCode,
          durationMs,
          outputBytes: result.outputBytes ?? Buffer.byteLength(result.stdout || ""),
        });
      } else {
        emit("capability.execution_failed", { capabilityId, exitCode: result.exitCode, durationMs });
      }
      return result;
    } catch (error) {
      emit("capability.execution_failed", {
        capabilityId,
        exitCode: null,
        durationMs: clock() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return Object.freeze({
    authorize,
    decide,
    execute,
    getPendingApproval: () => publicApproval(pending),
    hasRunGrant: (capabilityId) => runGrants.has(capabilityId),
  });
};

export const readCapabilityPolicy = (file) => {
  if (!existsSync(file)) return { catalogGrants: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && parsed.catalogGrants && typeof parsed.catalogGrants === "object"
      ? parsed
      : { catalogGrants: {} };
  } catch {
    return { catalogGrants: {} };
  }
};

export const hasCatalogGrant = (policy, catalogId, capabilityId) =>
  Array.isArray(policy.catalogGrants[catalogId]) && policy.catalogGrants[catalogId].includes(capabilityId);

export const grantCatalogCapability = (policy, catalogId, capabilityId) => ({
  ...policy,
  catalogGrants: {
    ...policy.catalogGrants,
    [catalogId]: [...new Set([...(policy.catalogGrants[catalogId] || []), capabilityId])].sort(),
  },
});

export const writeCapabilityPolicy = (file, policy) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
};
