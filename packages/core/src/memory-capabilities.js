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

const ensureStore = (store) => {
  for (const method of ["get", "search", "apply"]) {
    if (!store || typeof store[method] !== "function") throw new Error(`memory capabilities require a store with ${method}()`);
  }
  return store;
};

const abortIfNeeded = (signal) => {
  if (signal?.aborted) throw new Error("Capability execution cancelled.");
};

export const DEFAULT_MEMORY_CATALOG_CAPABILITIES = Object.freeze({
  "memory-recaller": Object.freeze(["memory.records.search", "memory.records.read"]),
  "memory-curator": Object.freeze(["memory.records.write", "memory.records.update", "memory.records.delete"]),
});

export const createMemoryCapabilityDefinitions = ({ store } = {}) => {
  const memoryStore = ensureStore(store);
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
      id: "memory.records.write",
      name: "Write persistent memory",
      description: "Atomically stores exact validated records in one persistent memory scope.",
      risk: "medium",
      approval: "always",
      allowedDecisions: ["allow-once", "deny"],
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
      allowedDecisions: ["allow-once", "deny"],
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
      allowedDecisions: ["allow-once", "deny"],
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
  ];
};

export const createMemoryCapabilityRegistry = ({
  store,
  catalogCapabilities = DEFAULT_MEMORY_CATALOG_CAPABILITIES,
} = {}) => createCapabilityRegistry({
  definitions: createMemoryCapabilityDefinitions({ store }),
  catalogCapabilities,
});
