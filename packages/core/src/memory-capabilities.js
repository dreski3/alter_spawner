import { createCapabilityRegistry } from "./capabilities.js";
import { MEMORY_KINDS } from "./memory.js";

const nullableString = { type: ["string", "null"] };
const memoryScopeSchema = {
  type: "object",
  required: ["project"],
  additionalProperties: false,
  properties: {
    project: { type: "string", minLength: 1, maxLength: 500 },
    catalog: { ...nullableString, maxLength: 200 },
    conversation: { ...nullableString, maxLength: 500 },
    namespace: { ...nullableString, maxLength: 500 },
  },
};

const memorySourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    runId: { ...nullableString, maxLength: 200 },
    catalogId: { ...nullableString, maxLength: 200 },
    messageIds: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
};

const memoryRecordProperties = {
  kind: { type: "string", enum: [...MEMORY_KINDS] },
  content: { type: "string", minLength: 1, maxLength: 20000 },
  tags: {
    type: "array",
    maxItems: 50,
    items: { type: "string", minLength: 1, maxLength: 100 },
  },
  source: memorySourceSchema,
  confidence: { type: "number", minimum: 0, maximum: 1 },
  expiresAt: { type: ["string", "null"], maxLength: 100 },
  metadata: { type: "object", additionalProperties: true },
};

const memoryRecordSchema = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: memoryRecordProperties,
};

const memoryPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: memoryRecordProperties,
};

const maintenanceOperationSchema = {
  type: "object",
  required: ["operation"],
  additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["put", "update", "delete"] },
    record: memoryRecordSchema,
    id: { type: "string", minLength: 1, maxLength: 200 },
    patch: memoryPatchSchema,
    expectedVersion: { type: "integer", minimum: 1 },
  },
};

const ensureStore = (store) => {
  for (const method of ["get", "search", "list", "stats", "apply", "compact"]) {
    if (!store || typeof store[method] !== "function") throw new Error(`memory capabilities require a store with ${method}()`);
  }
  return store;
};

const abortIfNeeded = (signal) => {
  if (signal?.aborted) throw new Error("Capability execution cancelled.");
};

// Every memory mutation ships pinned to one decision — allow once, or deny. That is
// right for a person who just asked for something to be remembered and is sitting
// there to answer, and wrong for an unattended curate or maintain cycle: the same
// card interrupts the same person with the same decision on every pass, and no answer
// they can give makes the next one stop, because a one-shot grant is the only grant a
// mutation can hold. A host that runs those cycles opts capabilities into durable
// grants — allow-run, always-catalog — one id at a time, so widening `write` never
// quietly widens `delete`.
export const MEMORY_MUTATION_CAPABILITIES = Object.freeze([
  "memory.records.write",
  "memory.records.update",
  "memory.records.delete",
  "memory.records.maintain",
  "memory.records.compact",
]);

const ONCE_ONLY_DECISIONS = Object.freeze(["allow-once", "deny"]);
// Compaction is repeatable within a run by default because it is idempotent, and not
// persistable by default because it rewrites the entire store under a write lock.
const COMPACT_DECISIONS = Object.freeze(["allow-once", "allow-run", "deny"]);
const GRANTABLE_DECISIONS = Object.freeze(["allow-once", "allow-run", "always-catalog", "deny"]);

// `true` is the whole-cycle switch: a host that wants curate and maintain to run
// unattended needs every mutation those cycles reach, and listing five ids to say so
// invites listing four by accident.
const resolveGrantable = (grantable) => {
  if (grantable === true) return new Set(MEMORY_MUTATION_CAPABILITIES);
  if (!grantable) return new Set();
  if (!Array.isArray(grantable)) {
    throw new Error("memory capability grantable must be true or an array of mutation capability ids");
  }
  for (const id of grantable) {
    if (!MEMORY_MUTATION_CAPABILITIES.includes(id)) {
      throw new Error(`memory capability ${id} is not a mutation whose approval can be made grantable`);
    }
  }
  return new Set(grantable);
};

export const DEFAULT_MEMORY_CATALOG_CAPABILITIES = Object.freeze({
  "memory-recaller": Object.freeze(["memory.records.search", "memory.records.read", "memory.records.stats"]),
  "memory-curator": Object.freeze(["memory.records.write", "memory.records.update", "memory.records.delete", "memory.records.stats"]),
  "memory-manager": Object.freeze([
    "memory.records.maintenance-scan",
    "memory.records.search",
    "memory.records.read",
    "memory.records.stats",
    "memory.records.maintain",
    "memory.records.compact",
  ]),
});

export const createMemoryCapabilityDefinitions = ({ store, grantable = false } = {}) => {
  const memoryStore = ensureStore(store);
  const grantableIds = resolveGrantable(grantable);
  const decisionsFor = (id, fallback) => [...(grantableIds.has(id) ? GRANTABLE_DECISIONS : fallback)];
  return [
    {
      id: "memory.records.search",
      name: "Search persistent memory",
      description: "Searches records visible to the requested project, catalog, and conversation scope.",
      risk: "medium",
      approval: "always",
      executorVersion: "memory-search-v1",
      inputSchema: {
        type: "object",
        required: ["query", "scope"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 2000 },
          scope: memoryScopeSchema,
          limit: { type: "integer", minimum: 1, maximum: 100 },
          kinds: { type: "array", maxItems: 4, items: { type: "string", enum: [...MEMORY_KINDS] } },
          tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
      approvalPreview: ({ query, scope, limit, kinds, tags }) => ({
        operation: "search",
        query,
        scope,
        limit: limit || 10,
        kinds: kinds || [],
        tags: tags || [],
      }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const results = await memoryStore.search(input.query, input.scope, {
          limit: input.limit,
          kinds: input.kinds,
          tags: input.tags,
        });
        abortIfNeeded(signal);
        return { results };
      },
    },
    {
      id: "memory.records.read",
      name: "Read persistent memory",
      description: "Reads one persistent memory record when it is visible to the requested scope.",
      risk: "medium",
      approval: "always",
      executorVersion: "memory-read-v1",
      inputSchema: {
        type: "object",
        required: ["id", "scope"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          scope: memoryScopeSchema,
        },
      },
      approvalPreview: ({ id, scope }) => ({ operation: "read", id, scope }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        return { record: await memoryStore.get(input.id, input.scope) };
      },
    },
    {
      id: "memory.records.stats",
      name: "Inspect persistent memory storage",
      description: "Reports storage consumption for records visible to the requested scope.",
      risk: "medium",
      approval: "always",
      executorVersion: "memory-stats-v1",
      inputSchema: {
        type: "object",
        required: ["scope"],
        additionalProperties: false,
        properties: { scope: memoryScopeSchema },
      },
      approvalPreview: ({ scope }) => ({ operation: "stats", scope }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        return { stats: await memoryStore.stats(input.scope) };
      },
    },
    {
      id: "memory.records.maintenance-scan",
      name: "Inspect memory maintenance candidates",
      description: "Returns bounded visible memory records together with native storage statistics.",
      risk: "medium",
      approval: "always",
      executorVersion: "memory-maintenance-scan-v1",
      inputSchema: {
        type: "object",
        required: ["scope"],
        additionalProperties: false,
        properties: {
          scope: memoryScopeSchema,
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          includeExpired: { type: "boolean" },
        },
      },
      approvalPreview: ({ scope, limit, includeExpired }) => ({
        operation: "maintenance-scan",
        scope,
        limit: limit || 100,
        includeExpired: includeExpired === true,
      }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const [stats, records] = await Promise.all([
          memoryStore.stats(input.scope),
          memoryStore.list(input.scope, { limit: input.limit, includeExpired: input.includeExpired }),
        ]);
        abortIfNeeded(signal);
        return { stats, records };
      },
    },
    {
      id: "memory.records.write",
      name: "Write persistent memory",
      description: "Atomically stores exact validated records in one persistent memory scope.",
      risk: "medium",
      approval: "always",
      allowedDecisions: decisionsFor("memory.records.write", ONCE_ONLY_DECISIONS),
      executorVersion: "memory-write-v1",
      inputSchema: {
        type: "object",
        required: ["scope", "records"],
        additionalProperties: false,
        properties: {
          scope: memoryScopeSchema,
          records: { type: "array", minItems: 1, maxItems: 50, items: memoryRecordSchema },
        },
      },
      approvalPreview: ({ scope, records }) => ({ operation: "write", scope, records }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const records = await memoryStore.apply(input.records.map((record) => ({
          operation: "put",
          scope: input.scope,
          record,
        })));
        abortIfNeeded(signal);
        return { records };
      },
    },
    {
      id: "memory.records.update",
      name: "Update persistent memory",
      description: "Atomically applies exact version-aware updates to persistent memory records.",
      risk: "medium",
      approval: "always",
      allowedDecisions: decisionsFor("memory.records.update", ONCE_ONLY_DECISIONS),
      executorVersion: "memory-update-v1",
      inputSchema: {
        type: "object",
        required: ["scope", "updates"],
        additionalProperties: false,
        properties: {
          scope: memoryScopeSchema,
          updates: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["id", "patch"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 200 },
                patch: memoryPatchSchema,
                expectedVersion: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      approvalPreview: ({ scope, updates }) => ({ operation: "update", scope, updates }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const records = await memoryStore.apply(input.updates.map((update) => ({
          operation: "update",
          scope: input.scope,
          id: update.id,
          patch: update.patch,
          expectedVersion: update.expectedVersion,
        })));
        abortIfNeeded(signal);
        return { records };
      },
    },
    {
      id: "memory.records.delete",
      name: "Delete persistent memory",
      description: "Atomically deletes exact version-aware persistent memory records.",
      risk: "high",
      approval: "always",
      allowedDecisions: decisionsFor("memory.records.delete", ONCE_ONLY_DECISIONS),
      executorVersion: "memory-delete-v1",
      inputSchema: {
        type: "object",
        required: ["scope", "records"],
        additionalProperties: false,
        properties: {
          scope: memoryScopeSchema,
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["id"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 200 },
                expectedVersion: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      approvalPreview: ({ scope, records }) => ({ operation: "delete", scope, records }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const records = await memoryStore.apply(input.records.map((record) => ({
          operation: "delete",
          scope: input.scope,
          id: record.id,
          expectedVersion: record.expectedVersion,
        })));
        abortIfNeeded(signal);
        return { records };
      },
    },
    {
      id: "memory.records.maintain",
      name: "Apply a memory maintenance plan",
      description: "Atomically applies an exact mixed write, update, and delete plan within one memory scope.",
      risk: "high",
      approval: "always",
      allowedDecisions: decisionsFor("memory.records.maintain", ONCE_ONLY_DECISIONS),
      executorVersion: "memory-maintain-v1",
      inputSchema: {
        type: "object",
        required: ["scope", "operations"],
        additionalProperties: false,
        properties: {
          scope: memoryScopeSchema,
          operations: { type: "array", minItems: 1, maxItems: 100, items: maintenanceOperationSchema },
        },
      },
      approvalPreview: ({ scope, operations }) => ({ operation: "maintain", scope, operations }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        const mutations = input.operations.map((operation, index) => {
          if (operation.operation === "put" && operation.record && !operation.id && !operation.patch && !operation.expectedVersion) {
            return { operation: "put", scope: input.scope, record: operation.record };
          }
          if (operation.operation === "update" && operation.id && operation.patch && !operation.record) {
            return {
              operation: "update",
              scope: input.scope,
              id: operation.id,
              patch: operation.patch,
              expectedVersion: operation.expectedVersion,
            };
          }
          if (operation.operation === "delete" && operation.id && !operation.record && !operation.patch) {
            return {
              operation: "delete",
              scope: input.scope,
              id: operation.id,
              expectedVersion: operation.expectedVersion,
            };
          }
          throw new Error(`memory maintenance operation ${index} has fields inconsistent with ${operation.operation}`);
        });
        const records = await memoryStore.apply(mutations);
        abortIfNeeded(signal);
        return { records };
      },
    },
    {
      id: "memory.records.compact",
      name: "Reclaim persistent memory storage",
      // Store-wide is stated here and in the preview because it is the one memory
      // capability whose effect reaches past the requested scope. It reclaims slack
      // only: no record is added, changed, or removed by compaction.
      description:
        "Reclaims unused storage across the whole memory store without changing any record. " +
        "The scope identifies the requester and selects the statistics reported back.",
      risk: "medium",
      approval: "always",
      // Repeatable within a run, and persisted across future runs only for a host that
      // asked: compaction is idempotent but rewrites the entire store and holds a write
      // lock while it does.
      allowedDecisions: decisionsFor("memory.records.compact", COMPACT_DECISIONS),
      executorVersion: "memory-compact-v1",
      inputSchema: {
        type: "object",
        required: ["scope"],
        additionalProperties: false,
        properties: { scope: memoryScopeSchema },
      },
      approvalPreview: ({ scope }) => ({ operation: "compact", scope, affects: "entire-store" }),
      handler: async ({ input, signal }) => {
        abortIfNeeded(signal);
        // Read the scoped stats first so a rejected scope fails before the store is
        // rewritten, and so "before" is not measured after compaction has run.
        const before = await memoryStore.stats(input.scope);
        abortIfNeeded(signal);
        const storage = await memoryStore.compact();
        abortIfNeeded(signal);
        return { storage, stats: await memoryStore.stats(input.scope), reclaimableBefore: before.reclaimableBytes };
      },
    },
  ];
};

export const createMemoryCapabilityRegistry = ({
  store,
  catalogCapabilities = DEFAULT_MEMORY_CATALOG_CAPABILITIES,
  grantable = false,
} = {}) => createCapabilityRegistry({
  definitions: createMemoryCapabilityDefinitions({ store, grantable }),
  catalogCapabilities,
});
