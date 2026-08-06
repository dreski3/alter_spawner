import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { kitDir, resolveProjectId } from "./config.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { createSqliteMemoryStore, sqliteMemoryFilePath } from "./sqlite-memory.js";
import { canonicalJson, normalizeJsonValue } from "./structured-data.js";

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_KINDS = Object.freeze(["fact", "preference", "decision", "summary"]);

const memoryKinds = new Set(MEMORY_KINDS);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => normalizeJsonValue(value);

const requiredString = (value, label, maxLength = 20000) => {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
};

const optionalString = (value, label, maxLength = 500) => {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, maxLength);
};

export const normalizeMemoryScope = (scope, label = "memory scope") => {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error(`${label} must be an object`);
  const unexpected = Object.keys(scope).filter((key) => !["project", "catalog", "conversation", "namespace"].includes(key));
  if (unexpected.length) throw new Error(`${label}.${unexpected[0]} is not allowed`);
  return Object.freeze({
    project: requiredString(scope.project, `${label}.project`, 500),
    catalog: optionalString(scope.catalog, `${label}.catalog`, 200),
    conversation: optionalString(scope.conversation, `${label}.conversation`, 500),
    namespace: optionalString(scope.namespace, `${label}.namespace`, 500),
  });
};

const sameScope = (left, right) =>
  left.project === right.project && left.catalog === right.catalog && left.conversation === right.conversation &&
  left.namespace === right.namespace;

const scopeCanRead = (request, record) =>
  request.project === record.project &&
  (record.catalog === null || request.catalog === record.catalog) &&
  (record.conversation === null || request.conversation === record.conversation) &&
  (record.namespace === null || request.namespace === record.namespace);

const scopeCanInspect = (request, record) =>
  request.project === record.project &&
  (request.catalog === null || request.catalog === record.catalog) &&
  (request.conversation === null || request.conversation === record.conversation) &&
  (request.namespace === null || request.namespace === record.namespace);

const normalizeTimestamp = (value, label) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp or null`);
  return new Date(value).toISOString();
};

const normalizeTags = (tags = []) => {
  if (!Array.isArray(tags) || tags.length > 50) throw new Error("memory tags must be an array of at most 50 strings");
  return Object.freeze([...new Set(tags.map((tag) => requiredString(tag, "memory tag", 100)))].sort());
};

const normalizeSource = (source = {}) => {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("memory source must be an object");
  const unexpected = Object.keys(source).filter((key) => !["runId", "catalogId", "messageIds"].includes(key));
  if (unexpected.length) throw new Error(`memory source.${unexpected[0]} is not allowed`);
  const messageIds = source.messageIds || [];
  if (!Array.isArray(messageIds) || messageIds.length > 100) throw new Error("memory source messageIds must be an array");
  return Object.freeze({
    runId: optionalString(source.runId, "memory source runId", 200),
    catalogId: optionalString(source.catalogId, "memory source catalogId", 200),
    messageIds: Object.freeze(messageIds.map((id) => requiredString(id, "memory source message id", 200))),
  });
};

export const normalizeMemoryInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("memory record must be an object");
  const unexpected = Object.keys(input).filter((key) => ![
    "kind",
    "content",
    "tags",
    "source",
    "confidence",
    "expiresAt",
    "metadata",
  ].includes(key));
  if (unexpected.length) throw new Error(`memory record.${unexpected[0]} is not allowed`);
  const kind = input.kind || "fact";
  if (!memoryKinds.has(kind)) throw new Error(`memory kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  const confidence = input.confidence === undefined ? 1 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("memory confidence must be between 0 and 1");
  const metadata = input.metadata === undefined ? {} : normalizeJsonValue(input.metadata, "memory metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("memory metadata must be an object");
  return Object.freeze({
    kind,
    content: requiredString(input.content, "memory content"),
    tags: normalizeTags(input.tags),
    source: normalizeSource(input.source),
    confidence,
    expiresAt: normalizeTimestamp(input.expiresAt, "memory expiresAt"),
    metadata,
  });
};

export const memoryContentHash = (scope, record) => createHash("sha256").update(canonicalJson({
  scope,
  kind: record.kind,
  content: record.content,
})).digest("hex");

export const memoryRecordLogicalBytes = (scope, record) => Buffer.byteLength(canonicalJson({
  scope,
  kind: record.kind,
  content: record.content,
  tags: record.tags,
  source: record.source,
  confidence: record.confidence,
  expiresAt: record.expiresAt,
  metadata: record.metadata,
}), "utf8");

const emptyDocument = (projectId) => ({
  schema_version: MEMORY_SCHEMA_VERSION,
  project_id: projectId,
  records: [],
});

const validateDocument = (document, projectId) => {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schema_version !== MEMORY_SCHEMA_VERSION ||
    document.project_id !== projectId ||
    !Array.isArray(document.records)
  ) {
    throw new Error("memory store document is invalid or belongs to another project");
  }
  if (document.records.some((record) => record?.scope?.project !== projectId)) {
    throw new Error("memory store contains a record from another project scope");
  }
  for (const record of document.records) {
    record.scope.namespace ??= null;
    record.logicalBytes ??= memoryRecordLogicalBytes(record.scope, record);
  }
  return document;
};

export const tokenizeMemoryQuery = (value) => [...new Set(String(value).toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])];

export const scoreMemorySearchResult = (record, query, terms) => {
  const content = record.content.toLocaleLowerCase();
  const tags = record.tags.map((tag) => tag.toLocaleLowerCase());
  const kind = record.kind.toLocaleLowerCase();
  let score = content.includes(query) ? 10 : 0;
  const matchedTerms = [];
  for (const term of terms) {
    let matched = false;
    if (tags.some((tag) => tag === term || tag.includes(term))) {
      score += 4;
      matched = true;
    }
    if (content.includes(term)) {
      score += 2;
      matched = true;
    }
    if (kind.includes(term)) {
      score += 1;
      matched = true;
    }
    if (matched) matchedTerms.push(term);
  }
  return { score, matchedTerms };
};

export const memoryFilePath = (root) => path.join(kitDir(root), "memory", "store.json");

export const createFileMemoryStore = ({
  file,
  projectId,
  runtime: runtimeOverride,
  lockTimeoutMs = 5000,
  staleLockMs = 30000,
  quotaBytes = null,
  namespaceQuotaBytes = {},
} = {}) => {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("memory store requires an absolute file path");
  const normalizedProjectId = requiredString(projectId, "memory store projectId", 500);
  const runtime = resolveRuntime(runtimeOverride);
  if (quotaBytes !== null && (!Number.isInteger(quotaBytes) || quotaBytes < 1)) {
    throw new Error("memory store quotaBytes must be a positive integer or null");
  }
  if (!namespaceQuotaBytes || typeof namespaceQuotaBytes !== "object" || Array.isArray(namespaceQuotaBytes)) {
    throw new Error("memory store namespaceQuotaBytes must be an object");
  }
  for (const [namespace, quota] of Object.entries(namespaceQuotaBytes)) {
    requiredString(namespace, "memory namespace quota key", 500);
    if (!Number.isInteger(quota) || quota < 1) throw new Error("memory namespace quotas must be positive integers");
  }
  const lockFile = `${file}.lock`;
  let writeQueue = Promise.resolve();
  const normalizeStoreScope = (scope) => {
    const normalized = normalizeMemoryScope(scope);
    if (normalized.project !== normalizedProjectId) {
      throw new Error(`memory scope project must match store project: ${normalizedProjectId}`);
    }
    return normalized;
  };

  const readDocument = () => {
    if (!existsSync(file)) return emptyDocument(normalizedProjectId);
    try {
      return validateDocument(JSON.parse(readFileSync(file, "utf8")), normalizedProjectId);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("memory store document is not valid JSON");
      throw error;
    }
  };

  const acquireLock = async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try {
        const descriptor = openSync(lockFile, "wx", 0o600);
        writeFileSync(descriptor, `${process.pid}\n`);
        return descriptor;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > staleLockMs) {
            unlinkSync(lockFile);
            continue;
          }
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
          continue;
        }
        if (Date.now() >= deadline) throw new Error("timed out waiting for the memory store lock");
        await wait(10);
      }
    }
  };

  const withWrite = (operation) => {
    const run = writeQueue.then(async () => {
      const descriptor = await acquireLock();
      try {
        const document = readDocument();
        const result = await operation(document);
        const serializedBytes = Buffer.byteLength(JSON.stringify(document, null, 2) + "\n", "utf8");
        if (quotaBytes !== null && serializedBytes > quotaBytes) {
          throw new Error(`memory store quota exceeded: ${serializedBytes} > ${quotaBytes} bytes`);
        }
        for (const [namespace, quota] of Object.entries(namespaceQuotaBytes)) {
          const used = document.records
            .filter((record) => record.scope.namespace === namespace)
            .reduce((total, record) => total + record.logicalBytes, 0);
          if (used > quota) throw new Error(`memory namespace quota exceeded for ${namespace}: ${used} > ${quota} bytes`);
        }
        writeJsonAtomic(file, document, { mode: 0o600 });
        chmodSync(file, 0o600);
        return clone(result);
      } finally {
        closeSync(descriptor);
        try {
          unlinkSync(lockFile);
        } catch {}
      }
    });
    writeQueue = run.catch(() => {});
    return run;
  };

  const get = async (id, scope) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const record = readDocument().records.find((item) => item.id === normalizedId && scopeCanRead(normalizedScope, item.scope));
    if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= runtime.now())) return null;
    return clone(record);
  };

  const search = async (query, scope, options = {}) => {
    const normalizedQuery = requiredString(query, "memory search query", 2000).toLocaleLowerCase();
    const normalizedScope = normalizeStoreScope(scope);
    const limit = options.limit === undefined ? 10 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("memory search limit must be an integer from 1 to 100");
    const kinds = options.kinds || [];
    if (!Array.isArray(kinds) || kinds.some((kind) => !memoryKinds.has(kind))) throw new Error("memory search kinds are invalid");
    const requiredTags = normalizeTags(options.tags || []).map((tag) => tag.toLocaleLowerCase());
    const terms = tokenizeMemoryQuery(normalizedQuery);
    const now = runtime.now();
    return readDocument().records
      .filter((record) => scopeCanRead(normalizedScope, record.scope))
      .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter((record) => kinds.length === 0 || kinds.includes(record.kind))
      .filter((record) => requiredTags.every((tag) => record.tags.some((candidate) => candidate.toLocaleLowerCase() === tag)))
      .map((record) => ({ record, ...scoreMemorySearchResult(record, normalizedQuery, terms) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt) || left.record.id.localeCompare(right.record.id))
      .slice(0, limit)
      .map(clone);
  };

  const list = async (scope, options = {}) => {
    const normalizedScope = normalizeStoreScope(scope);
    const limit = options.limit === undefined ? 100 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("memory list limit must be an integer from 1 to 1000");
    }
    const includeExpired = options.includeExpired === true;
    const now = runtime.now();
    return readDocument().records
      .filter((record) => scopeCanInspect(normalizedScope, record.scope))
      .filter((record) => includeExpired || !record.expiresAt || Date.parse(record.expiresAt) > now)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  };

  const stats = async (scope) => {
    const normalizedScope = normalizeStoreScope(scope);
    const document = readDocument();
    const now = runtime.now();
    const visible = document.records.filter((record) => scopeCanInspect(normalizedScope, record.scope));
    const active = visible.filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now);
    const byNamespace = {};
    for (const record of visible) {
      const namespace = record.scope.namespace || "default";
      const entry = byNamespace[namespace] ||= { records: 0, activeRecords: 0, logicalBytes: 0 };
      entry.records += 1;
      entry.logicalBytes += record.logicalBytes;
      if (!record.expiresAt || Date.parse(record.expiresAt) > now) entry.activeRecords += 1;
    }
    let physicalBytes = 0;
    try {
      physicalBytes = statSync(file).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const logicalBytes = visible.reduce((total, record) => total + record.logicalBytes, 0);
    return clone({
      physicalBytes,
      // Every write rewrites the whole document, so the file holds exactly the live
      // records and there is never slack to reclaim. Both fields are reported anyway
      // so a caller can read storage the same way whichever backend is underneath.
      fileBytes: physicalBytes,
      reclaimableBytes: 0,
      logicalBytes,
      recordCount: visible.length,
      activeRecordCount: active.length,
      expiredRecordCount: visible.length - active.length,
      quotaBytes,
      quotaRatio: quotaBytes === null ? null : physicalBytes / quotaBytes,
      byNamespace,
    });
  };

  const putInDocument = (document, input, scope) => {
    const normalizedScope = normalizeStoreScope(scope);
    const normalized = normalizeMemoryInput(input);
    const hash = memoryContentHash(normalizedScope, normalized);
    const duplicate = document.records.find((record) =>
      record.contentHash === hash &&
      sameScope(record.scope, normalizedScope) &&
      (!record.expiresAt || Date.parse(record.expiresAt) > runtime.now()));
    if (duplicate) return duplicate;
    let id;
    do id = `mem_${runtime.randomId(16)}`;
    while (document.records.some((record) => record.id === id));
    const timestamp = new Date(runtime.now()).toISOString();
    const record = {
      id,
      scope: normalizedScope,
      ...normalized,
      contentHash: hash,
      logicalBytes: memoryRecordLogicalBytes(normalizedScope, normalized),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    document.records.push(record);
    return record;
  };

  const updateInDocument = (document, id, patch, scope, { expectedVersion } = {}) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const index = document.records.findIndex((record) => record.id === normalizedId && sameScope(record.scope, normalizedScope));
    if (index < 0) throw new Error(`memory record not found: ${normalizedId}`);
    const current = document.records[index];
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error(`memory record version conflict: expected ${expectedVersion}, found ${current.version}`);
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("memory update patch must be an object");
    if (Object.keys(patch).length === 0) throw new Error("memory update patch must not be empty");
    const normalized = normalizeMemoryInput({
      kind: patch.kind ?? current.kind,
      content: patch.content ?? current.content,
      tags: patch.tags ?? current.tags,
      source: patch.source ?? current.source,
      confidence: patch.confidence ?? current.confidence,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      metadata: patch.metadata ?? current.metadata,
    });
    const updated = {
      ...current,
      ...normalized,
      contentHash: memoryContentHash(normalizedScope, normalized),
      logicalBytes: memoryRecordLogicalBytes(normalizedScope, normalized),
      version: current.version + 1,
      updatedAt: new Date(runtime.now()).toISOString(),
    };
    document.records[index] = updated;
    return updated;
  };

  const removeFromDocument = (document, id, scope, { expectedVersion } = {}) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const index = document.records.findIndex((record) => record.id === normalizedId && sameScope(record.scope, normalizedScope));
    if (index < 0) throw new Error(`memory record not found: ${normalizedId}`);
    const record = document.records[index];
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      throw new Error(`memory record version conflict: expected ${expectedVersion}, found ${record.version}`);
    }
    document.records.splice(index, 1);
    return record;
  };

  const apply = (mutations) => {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 100) {
      return Promise.reject(new Error("memory mutations must contain from 1 to 100 operations"));
    }
    return withWrite((document) => mutations.map((mutation, index) => {
      if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
        throw new Error(`memory mutation ${index} must be an object`);
      }
      if (mutation.operation === "put") return putInDocument(document, mutation.record, mutation.scope);
      if (mutation.operation === "update") {
        return updateInDocument(document, mutation.id, mutation.patch, mutation.scope, { expectedVersion: mutation.expectedVersion });
      }
      if (mutation.operation === "delete") {
        return removeFromDocument(document, mutation.id, mutation.scope, { expectedVersion: mutation.expectedVersion });
      }
      throw new Error(`memory mutation ${index} has an invalid operation`);
    }));
  };

  // Part of the store contract so callers never have to branch on the backend.
  // Rewriting the document is what every write already does, so there is nothing
  // left to reclaim and this deliberately touches no records.
  const compact = async () => {
    let physicalBytes = 0;
    try {
      physicalBytes = statSync(file).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return clone({ physicalBytes, fileBytes: physicalBytes, reclaimableBytes: 0, reclaimedBytes: 0 });
  };

  const put = async (input, scope) => (await apply([{ operation: "put", record: input, scope }]))[0];
  const update = async (id, patch, scope, options = {}) =>
    (await apply([{ operation: "update", id, patch, scope, expectedVersion: options.expectedVersion }]))[0];
  const remove = async (id, scope, options = {}) =>
    (await apply([{ operation: "delete", id, scope, expectedVersion: options.expectedVersion }]))[0];

  return Object.freeze({
    file,
    projectId: normalizedProjectId,
    backend: "json",
    get,
    search,
    list,
    stats,
    put,
    update,
    delete: remove,
    apply,
    compact,
  });
};

export const createProjectMemoryStore = (root, options = {}) => {
  const projectId = resolveProjectId(root, options.projectId);
  if (options.backend === "sqlite") {
    return createSqliteMemoryStore({
      ...options,
      file: options.file || sqliteMemoryFilePath(root),
      projectId,
    });
  }
  if (options.backend !== undefined && options.backend !== "json") {
    throw new Error("memory store backend must be json or sqlite");
  }
  return createFileMemoryStore({
    ...options,
    file: options.file || memoryFilePath(root),
    projectId,
  });
};
