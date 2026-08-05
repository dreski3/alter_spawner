import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { resolveRuntime } from "./runtime.js";
import { canonicalJson, normalizeJsonValue } from "./structured-data.js";
import {
  MEMORY_KINDS,
  memoryContentHash,
  memoryRecordLogicalBytes,
  normalizeMemoryInput,
  normalizeMemoryScope,
  scoreMemorySearchResult,
  tokenizeMemoryQuery,
} from "./memory.js";

export const SQLITE_MEMORY_SCHEMA_VERSION = 1;

const clone = (value) => normalizeJsonValue(value);

const requiredString = (value, label, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
};

const parseJson = (value, label) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`SQLite memory ${label} contains invalid JSON`);
  }
};

const rowScope = (row) => ({
  project: row.project,
  catalog: row.catalog,
  conversation: row.conversation,
  namespace: row.namespace,
});

const rowToRecord = (row) => ({
  id: row.id,
  scope: rowScope(row),
  kind: row.kind,
  content: row.content,
  tags: parseJson(row.tags_json, "tags"),
  source: parseJson(row.source_json, "source"),
  confidence: row.confidence,
  expiresAt: row.expires_at,
  metadata: parseJson(row.metadata_json, "metadata"),
  contentHash: row.content_hash,
  logicalBytes: row.logical_bytes,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// The -shm file is deliberately excluded. It is a fixed-size runtime index that
// only exists while a connection is open and that compaction cannot reclaim, so
// counting it would leave reclaimableBytes permanently above zero and invite a
// memory manager to compact forever chasing a floor it can never reach.
const fileBytesFor = (file) => {
  let total = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try {
      total += statSync(candidate).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return total;
};

const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

const validateQuotas = (quotaBytes, namespaceQuotaBytes) => {
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
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    catalog TEXT,
    conversation TEXT,
    namespace TEXT,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    expires_at TEXT,
    metadata_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    logical_bytes INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_scope_idx
    ON memory_records(project, catalog, conversation, namespace);
  CREATE INDEX IF NOT EXISTS memory_hash_idx
    ON memory_records(content_hash, project, catalog, conversation, namespace);
  CREATE INDEX IF NOT EXISTS memory_updated_idx ON memory_records(updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS memory_expiry_idx ON memory_records(expires_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    content,
    tags,
    kind,
    tokenize = 'unicode61'
  );
`;

export const sqliteMemoryFilePath = (root) => path.join(kitDir(root), "memory", "store.sqlite");

export const createSqliteMemoryStore = ({
  file,
  projectId,
  runtime: runtimeOverride,
  quotaBytes = null,
  namespaceQuotaBytes = {},
  busyTimeoutMs = 5000,
  journalSizeLimitBytes = DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
} = {}) => {
  if (typeof file !== "string" || (!path.isAbsolute(file) && file !== ":memory:")) {
    throw new Error("SQLite memory store requires an absolute file path or :memory:");
  }
  const normalizedProjectId = requiredString(projectId, "memory store projectId", 500);
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error("SQLite memory store busyTimeoutMs must be a non-negative integer");
  }
  if (!Number.isInteger(journalSizeLimitBytes) || journalSizeLimitBytes < 0) {
    throw new Error("SQLite memory store journalSizeLimitBytes must be a non-negative integer");
  }
  validateQuotas(quotaBytes, namespaceQuotaBytes);
  const runtime = resolveRuntime(runtimeOverride);
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    // WAL files are truncated back to this ceiling after each checkpoint. Without
    // it the journal grows without bound for the life of the store, because the
    // default autocheckpoint reuses WAL space instead of returning it.
    database.exec(`PRAGMA journal_size_limit = ${journalSizeLimitBytes}`);
  }
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec(SCHEMA);
  const getMeta = database.prepare("SELECT value FROM memory_meta WHERE key = ?");
  const putMeta = database.prepare("INSERT INTO memory_meta(key, value) VALUES (?, ?)");
  const schemaVersion = getMeta.get("schema_version")?.value;
  const storedProjectId = getMeta.get("project_id")?.value;
  if (schemaVersion === undefined) {
    database.exec("BEGIN IMMEDIATE");
    try {
      putMeta.run("schema_version", String(SQLITE_MEMORY_SCHEMA_VERSION));
      putMeta.run("project_id", normalizedProjectId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  } else if (Number(schemaVersion) !== SQLITE_MEMORY_SCHEMA_VERSION || storedProjectId !== normalizedProjectId) {
    database.close();
    throw new Error("SQLite memory store is invalid or belongs to another project");
  }
  if (file !== ":memory:") chmodSync(file, 0o600);

  const normalizeStoreScope = (scope) => {
    const normalized = normalizeMemoryScope(scope);
    if (normalized.project !== normalizedProjectId) {
      throw new Error(`memory scope project must match store project: ${normalizedProjectId}`);
    }
    return normalized;
  };

  const rowById = (id) => database.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) || null;
  const exactRow = (id, scope) => database.prepare(`
    SELECT * FROM memory_records
    WHERE id = ? AND project = ? AND catalog IS ? AND conversation IS ? AND namespace IS ?
  `).get(id, scope.project, scope.catalog, scope.conversation, scope.namespace) || null;
  const readableScopeSql = `
    project = ? AND (catalog IS NULL OR catalog = ?) AND
    (conversation IS NULL OR conversation = ?) AND (namespace IS NULL OR namespace = ?)
  `;
  const inspectableScopeSql = `
    project = ? AND (? IS NULL OR catalog = ?) AND
    (? IS NULL OR conversation = ?) AND (? IS NULL OR namespace = ?)
  `;
  const readableScopeArgs = (scope) => [scope.project, scope.catalog, scope.conversation, scope.namespace];
  const inspectableScopeArgs = (scope) => [
    scope.project,
    scope.catalog,
    scope.catalog,
    scope.conversation,
    scope.conversation,
    scope.namespace,
    scope.namespace,
  ];

  const insertFts = (record) => database.prepare(
    "INSERT INTO memory_fts(rowid, id, content, tags, kind) VALUES ((SELECT rowid FROM memory_records WHERE id = ?), ?, ?, ?, ?)",
  ).run(record.id, record.id, record.content, record.tags.join(" "), record.kind);
  const removeFts = (id) => database.prepare("DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory_records WHERE id = ?)").run(id);

  const insertRecord = (record) => {
    database.prepare(`
      INSERT INTO memory_records(
        id, project, catalog, conversation, namespace, kind, content, tags_json, source_json,
        confidence, expires_at, metadata_json, content_hash, logical_bytes, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.scope.project,
      record.scope.catalog,
      record.scope.conversation,
      record.scope.namespace,
      record.kind,
      record.content,
      JSON.stringify(record.tags),
      JSON.stringify(record.source),
      record.confidence,
      record.expiresAt,
      JSON.stringify(record.metadata),
      record.contentHash,
      record.logicalBytes,
      record.version,
      record.createdAt,
      record.updatedAt,
    );
    insertFts(record);
  };

  const replaceRecord = (record) => {
    removeFts(record.id);
    database.prepare(`
      UPDATE memory_records SET
        kind = ?, content = ?, tags_json = ?, source_json = ?, confidence = ?, expires_at = ?,
        metadata_json = ?, content_hash = ?, logical_bytes = ?, version = ?, updated_at = ?
      WHERE id = ?
    `).run(
      record.kind,
      record.content,
      JSON.stringify(record.tags),
      JSON.stringify(record.source),
      record.confidence,
      record.expiresAt,
      JSON.stringify(record.metadata),
      record.contentHash,
      record.logicalBytes,
      record.version,
      record.updatedAt,
      record.id,
    );
    insertFts(record);
  };

  // physicalBytes counts only live pages, so deleting records lowers it the way a
  // rewritten JSON document would. fileBytes is the raw on-disk high-water mark,
  // which SQLite never gives back on its own, and their difference is exactly what
  // compact() can reclaim. Reporting the file size as physicalBytes would tell a
  // memory manager that its own cleanup had freed nothing.
  const storageBytes = () => {
    const pages = database.prepare(`
      SELECT
        (SELECT * FROM pragma_page_count()) AS pages,
        (SELECT * FROM pragma_freelist_count()) AS freePages,
        (SELECT * FROM pragma_page_size()) AS pageSize
    `).get();
    const physicalBytes = (pages.pages - pages.freePages) * pages.pageSize;
    const fileBytes = file === ":memory:" ? pages.pages * pages.pageSize : fileBytesFor(file);
    return { physicalBytes, fileBytes, reclaimableBytes: Math.max(0, fileBytes - physicalBytes) };
  };

  const quotaUsage = () => ({
    logicalBytes: database.prepare("SELECT COALESCE(SUM(logical_bytes), 0) AS bytes FROM memory_records").get().bytes,
    namespaces: Object.fromEntries(database.prepare(`
      SELECT namespace, COALESCE(SUM(logical_bytes), 0) AS bytes
      FROM memory_records WHERE namespace IS NOT NULL GROUP BY namespace
    `).all().map((row) => [row.namespace, row.bytes])),
  });

  const enforceQuotas = (before) => {
    if (quotaBytes !== null) {
      const used = storageBytes().physicalBytes;
      const logicalBytes = quotaUsage().logicalBytes;
      if (used > quotaBytes && logicalBytes >= before.logicalBytes) {
        throw new Error(`memory store quota exceeded: ${used} > ${quotaBytes} bytes`);
      }
    }
    for (const [namespace, quota] of Object.entries(namespaceQuotaBytes)) {
      const used = database.prepare(
        "SELECT COALESCE(SUM(logical_bytes), 0) AS bytes FROM memory_records WHERE namespace = ?",
      ).get(namespace).bytes;
      if (used > quota && used >= (before.namespaces[namespace] || 0)) {
        throw new Error(`memory namespace quota exceeded for ${namespace}: ${used} > ${quota} bytes`);
      }
    }
  };

  const transaction = (operation) => {
    const before = quotaUsage();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      enforceQuotas(before);
      database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const putInTransaction = (input, scope) => {
    const normalizedScope = normalizeStoreScope(scope);
    const normalized = normalizeMemoryInput(input);
    const hash = memoryContentHash(normalizedScope, normalized);
    const duplicate = database.prepare(`
      SELECT * FROM memory_records
      WHERE content_hash = ? AND project = ? AND catalog IS ? AND conversation IS ? AND namespace IS ?
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1
    `).get(
      hash,
      normalizedScope.project,
      normalizedScope.catalog,
      normalizedScope.conversation,
      normalizedScope.namespace,
      new Date(runtime.now()).toISOString(),
    );
    if (duplicate) return rowToRecord(duplicate);
    let id;
    do id = `mem_${runtime.randomId(16)}`;
    while (rowById(id));
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
    insertRecord(record);
    return record;
  };

  const updateInTransaction = (id, patch, scope, { expectedVersion } = {}) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const row = exactRow(normalizedId, normalizedScope);
    if (!row) throw new Error(`memory record not found: ${normalizedId}`);
    const current = rowToRecord(row);
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
    replaceRecord(updated);
    return updated;
  };

  const deleteInTransaction = (id, scope, { expectedVersion } = {}) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const row = exactRow(normalizedId, normalizedScope);
    if (!row) throw new Error(`memory record not found: ${normalizedId}`);
    const record = rowToRecord(row);
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      throw new Error(`memory record version conflict: expected ${expectedVersion}, found ${record.version}`);
    }
    removeFts(record.id);
    database.prepare("DELETE FROM memory_records WHERE id = ?").run(record.id);
    return record;
  };

  const apply = async (mutations) => {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > 100) {
      throw new Error("memory mutations must contain from 1 to 100 operations");
    }
    return transaction(() => mutations.map((mutation, index) => {
      if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
        throw new Error(`memory mutation ${index} must be an object`);
      }
      if (mutation.operation === "put") return putInTransaction(mutation.record, mutation.scope);
      if (mutation.operation === "update") {
        return updateInTransaction(mutation.id, mutation.patch, mutation.scope, { expectedVersion: mutation.expectedVersion });
      }
      if (mutation.operation === "delete") {
        return deleteInTransaction(mutation.id, mutation.scope, { expectedVersion: mutation.expectedVersion });
      }
      throw new Error(`memory mutation ${index} has an invalid operation`);
    }));
  };

  const get = async (id, scope) => {
    const normalizedId = requiredString(id, "memory id", 200);
    const normalizedScope = normalizeStoreScope(scope);
    const row = database.prepare(`
      SELECT * FROM memory_records WHERE id = ? AND ${readableScopeSql}
    `).get(normalizedId, ...readableScopeArgs(normalizedScope));
    if (!row) return null;
    const record = rowToRecord(row);
    if (record.expiresAt && Date.parse(record.expiresAt) <= runtime.now()) return null;
    return clone(record);
  };

  const search = async (query, scope, options = {}) => {
    const normalizedQuery = requiredString(query, "memory search query", 2000).toLocaleLowerCase();
    const normalizedScope = normalizeStoreScope(scope);
    const limit = options.limit === undefined ? 10 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("memory search limit must be an integer from 1 to 100");
    const kinds = options.kinds || [];
    if (!Array.isArray(kinds) || kinds.some((kind) => !MEMORY_KINDS.includes(kind))) throw new Error("memory search kinds are invalid");
    const requiredTags = [...new Set((options.tags || []).map((tag) => requiredString(tag, "memory tag", 100)))].map((tag) => tag.toLocaleLowerCase());
    const terms = tokenizeMemoryQuery(normalizedQuery);
    const rows = terms.length
      ? database.prepare(`
        SELECT memory_records.* FROM memory_fts
        JOIN memory_records ON memory_records.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ? AND ${readableScopeSql}
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 5000
      `).all(
        terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "),
        ...readableScopeArgs(normalizedScope),
        new Date(runtime.now()).toISOString(),
      )
      : database.prepare(`SELECT * FROM memory_records WHERE ${readableScopeSql}`).all(...readableScopeArgs(normalizedScope));
    const now = runtime.now();
    return rows
      .map(rowToRecord)
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
    const expirySql = includeExpired ? "" : " AND (expires_at IS NULL OR expires_at > ?)";
    const args = inspectableScopeArgs(normalizedScope);
    if (!includeExpired) args.push(new Date(now).toISOString());
    return database.prepare(`
      SELECT * FROM memory_records
      WHERE ${inspectableScopeSql}${expirySql}
      ORDER BY updated_at DESC, id ASC LIMIT ?
    `).all(...args, limit)
      .map(rowToRecord)
      .map(clone);
  };

  const stats = async (scope) => {
    const normalizedScope = normalizeStoreScope(scope);
    const now = runtime.now();
    const groups = database.prepare(`
      SELECT
        COALESCE(namespace, 'default') AS namespace_key,
        COUNT(*) AS records,
        SUM(CASE WHEN expires_at IS NULL OR expires_at > ? THEN 1 ELSE 0 END) AS active_records,
        COALESCE(SUM(logical_bytes), 0) AS logical_bytes
      FROM memory_records
      WHERE ${inspectableScopeSql}
      GROUP BY namespace_key
    `).all(new Date(now).toISOString(), ...inspectableScopeArgs(normalizedScope));
    const byNamespace = {};
    let recordCount = 0;
    let activeRecordCount = 0;
    let logicalBytes = 0;
    for (const group of groups) {
      byNamespace[group.namespace_key] = {
        records: group.records,
        activeRecords: group.active_records,
        logicalBytes: group.logical_bytes,
      };
      recordCount += group.records;
      activeRecordCount += group.active_records;
      logicalBytes += group.logical_bytes;
    }
    const { physicalBytes, fileBytes, reclaimableBytes } = storageBytes();
    return clone({
      physicalBytes,
      fileBytes,
      reclaimableBytes,
      logicalBytes,
      recordCount,
      activeRecordCount,
      expiredRecordCount: recordCount - activeRecordCount,
      quotaBytes,
      quotaRatio: quotaBytes === null ? null : physicalBytes / quotaBytes,
      byNamespace,
    });
  };

  // Three separate reclaims, in order. Deleting an FTS row only writes a tombstone,
  // so the index is merged first to drop them; VACUUM then rewrites the database
  // without its freelist; the final checkpoint returns the WAL space VACUUM itself
  // just consumed. VACUUM cannot run inside a transaction, so this is not part of
  // transaction().
  const compact = async () => {
    const before = storageBytes();
    database.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
    database.exec("VACUUM");
    if (file !== ":memory:") database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const after = storageBytes();
    return clone({
      physicalBytes: after.physicalBytes,
      fileBytes: after.fileBytes,
      reclaimableBytes: after.reclaimableBytes,
      reclaimedBytes: Math.max(0, before.fileBytes - after.fileBytes),
    });
  };

  const importRecords = async (records) => {
    if (!Array.isArray(records)) throw new Error("SQLite memory import records must be an array");
    return transaction(() => {
      let imported = 0;
      let skipped = 0;
      for (const [index, source] of records.entries()) {
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          throw new Error(`SQLite memory import record ${index} must be an object`);
        }
        const scope = normalizeStoreScope(source.scope);
        const normalized = normalizeMemoryInput({
          kind: source.kind,
          content: source.content,
          tags: source.tags,
          source: source.source,
          confidence: source.confidence,
          expiresAt: source.expiresAt,
          metadata: source.metadata,
        });
        const record = {
          id: requiredString(source.id, `SQLite memory import record ${index} id`, 200),
          scope,
          ...normalized,
          contentHash: memoryContentHash(scope, normalized),
          logicalBytes: memoryRecordLogicalBytes(scope, normalized),
          version: Number(source.version),
          createdAt: new Date(source.createdAt).toISOString(),
          updatedAt: new Date(source.updatedAt).toISOString(),
        };
        if (!Number.isInteger(record.version) || record.version < 1) throw new Error(`SQLite memory import record ${index} version is invalid`);
        const existing = rowById(record.id);
        if (existing) {
          const current = rowToRecord(existing);
          if (canonicalJson(current) !== canonicalJson(record)) {
            throw new Error(`SQLite memory import conflict for record: ${record.id}`);
          }
          skipped += 1;
          continue;
        }
        insertRecord(record);
        imported += 1;
      }
      return { imported, skipped, total: records.length };
    });
  };

  return Object.freeze({
    file,
    projectId: normalizedProjectId,
    backend: "sqlite",
    get,
    search,
    list,
    stats,
    put: async (input, scope) => (await apply([{ operation: "put", record: input, scope }]))[0],
    update: async (id, patch, scope, options = {}) =>
      (await apply([{ operation: "update", id, patch, scope, expectedVersion: options.expectedVersion }]))[0],
    delete: async (id, scope, options = {}) =>
      (await apply([{ operation: "delete", id, scope, expectedVersion: options.expectedVersion }]))[0],
    apply,
    compact,
    importRecords,
    close: () => database.close(),
  });
};

export const migrateFileMemoryStoreToSqlite = async ({
  sourceFile,
  destinationFile,
  projectId,
  runtime,
  quotaBytes = null,
  namespaceQuotaBytes = {},
  busyTimeoutMs = 5000,
  journalSizeLimitBytes = DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
} = {}) => {
  if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
    throw new Error("memory migration requires an absolute sourceFile");
  }
  if (!existsSync(sourceFile)) throw new Error(`memory migration source does not exist: ${sourceFile}`);
  let document;
  try {
    document = JSON.parse(readFileSync(sourceFile, "utf8"));
  } catch {
    throw new Error("memory migration source is not valid JSON");
  }
  const normalizedProjectId = requiredString(projectId || document?.project_id, "memory migration projectId", 500);
  if (
    !document || typeof document !== "object" || Array.isArray(document) || document.schema_version !== 1 ||
    document.project_id !== normalizedProjectId || !Array.isArray(document.records)
  ) {
    throw new Error("memory migration source is invalid or belongs to another project");
  }
  const store = createSqliteMemoryStore({
    file: destinationFile,
    projectId: normalizedProjectId,
    runtime,
    quotaBytes,
    namespaceQuotaBytes,
    busyTimeoutMs,
    journalSizeLimitBytes,
  });
  try {
    const result = await store.importRecords(document.records);
    // Importing the whole document is the largest single write this store will ever
    // see, so the new database is compacted before use rather than being handed over
    // carrying the journal that the import produced.
    const storage = await store.compact();
    return { ...result, sourceFile, destinationFile, projectId: normalizedProjectId, storage };
  } finally {
    store.close();
  }
};
