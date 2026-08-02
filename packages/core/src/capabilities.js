import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  })));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
});

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
  return Object.freeze({
    get: (id) => registered.get(id) || null,
    forCatalog: (catalogId) => (bindings[catalogId] || []).map(requireCapability),
    listPublic: () => [...registered.values()].map(publicCapability),
    commandPreview: (id, platform = process.platform) => {
      const definition = requireCapability(id);
      const executor = definition.executors[platform];
      return executor ? [executor.file, ...executor.args].join(" ") : `Unavailable on ${platform}`;
    },
    execute: async (id, options) => executeDefinition(requireCapability(id), options),
  });
};

export class CapabilityDeniedError extends Error {
  constructor(capability) {
    super(`${capability.name} was denied. No host command was executed.`);
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
  if (!registry || typeof registry.get !== "function" || typeof registry.execute !== "function") {
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
  const authorize = async (capabilityId, { reason, platform } = {}) => {
    const definition = registry.get(capabilityId);
    if (!definition) throw new Error(`unknown capability: ${capabilityId}`);
    if (signal?.aborted) throw new Error("Run cancelled while waiting for capability approval.");
    if (pending) throw new Error("another capability approval is already pending");
    if (definition.approval !== "always") {
      emit("capability.auto_approved", { capabilityId, decision: "not-required" });
      return { decision: "not-required" };
    }
    if (runGrants.has(capabilityId)) {
      emit("capability.auto_approved", { capabilityId, decision: "allow-run" });
      return { decision: "allow-run" };
    }
    if (isPersistentlyApproved({ catalogId, capabilityId })) {
      emit("capability.auto_approved", { capabilityId, decision: "always-catalog" });
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
        commandPreview: registry.commandPreview(capabilityId, platform),
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

  const decide = async (approvalId, decision) => {
    const approval = pending;
    if (!approval || approval.id !== approvalId) throw new Error("approval request is no longer pending");
    if (!approvalDecisions.has(decision)) throw new Error("invalid approval decision");
    if (decision === "always-catalog") {
      await persistApproval({ catalogId, capabilityId: approval.capabilityId, decision, approval: publicApproval(approval) });
    }
    await audit({ catalogId, capabilityId: approval.capabilityId, decision, approval: publicApproval(approval) });
    approval.cleanup?.();
    pending = null;
    if (decision === "allow-run") runGrants.add(approval.capabilityId);
    if (decision === "deny") emit("capability.denied", { capabilityId: approval.capabilityId, decision });
    else emit("capability.approved", { capabilityId: approval.capabilityId, decision });
    approval.resolve({ decision });
    return { decision };
  };

  const execute = async (capabilityId, options = {}) => {
    const definition = registry.get(capabilityId);
    if (!definition) throw new Error(`unknown capability: ${capabilityId}`);
    const { decision } = await authorize(capabilityId, options);
    if (decision === "deny") throw new CapabilityDeniedError(definition);
    const commandPreview = registry.commandPreview(capabilityId, options.platform);
    emit("capability.execution_started", { capabilityId, commandPreview });
    const startedAt = clock();
    try {
      const result = await registry.execute(capabilityId, { signal, platform: options.platform });
      const durationMs = clock() - startedAt;
      if (result.ok) {
        emit("capability.execution_completed", {
          capabilityId,
          exitCode: result.exitCode,
          durationMs,
          outputBytes: Buffer.byteLength(result.stdout || ""),
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
