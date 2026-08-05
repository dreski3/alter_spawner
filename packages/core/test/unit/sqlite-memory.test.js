import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFileMemoryStore,
  createProjectMemoryStore,
  createSqliteMemoryStore,
  memoryFilePath,
  migrateFileMemoryStoreToSqlite,
  sqliteMemoryFilePath,
} from "@mind/core";

const fixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-sqlite-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let currentTime = Date.parse("2026-08-05T10:00:00.000Z");
  let nextId = 0;
  const runtime = {
    now: () => currentTime,
    randomId: () => String(nextId += 1).padStart(16, "0"),
    env: {},
  };
  return {
    root,
    runtime,
    setTime: (value) => { currentTime = Date.parse(value); },
  };
};

test("SQLite store matches scoped record, version, deduplication, and expiry behavior", async (t) => {
  const { root, runtime, setTime } = fixture(t);
  const store = createSqliteMemoryStore({ file: sqliteMemoryFilePath(root), projectId: "naut", runtime });
  t.after(() => store.close());
  const project = { project: "naut" };
  const architecture = { project: "naut", catalog: "architect", namespace: "architecture" };
  const global = await store.put({ content: "The project uses npm.", tags: ["build"] }, project);
  const decision = await store.put({ content: "Use SQLite for persistent memory.", kind: "decision" }, architecture);
  assert.equal((await store.get(global.id, architecture)).id, global.id);
  assert.equal(await store.get(decision.id, project), null);
  assert.equal((await store.put({ content: "Use SQLite for persistent memory.", kind: "decision" }, architecture)).id, decision.id);
  const updated = await store.update(decision.id, { metadata: { supersedes: ["mem_old"] } }, architecture, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  await assert.rejects(store.update(decision.id, { content: "stale" }, architecture, { expectedVersion: 1 }), /version conflict/);
  const temporary = await store.put({ content: "Temporary migration note.", expiresAt: "2026-08-05T11:00:00.000Z" }, architecture);
  setTime("2026-08-05T12:00:00.000Z");
  assert.equal(await store.get(temporary.id, architecture), null);
  assert.equal((await store.list(architecture, { includeExpired: true })).length, 2);
});

test("FTS retrieval stays synchronized across writes, updates, and deletes", async (t) => {
  const { root, runtime } = fixture(t);
  const store = createSqliteMemoryStore({ file: sqliteMemoryFilePath(root), projectId: "naut", runtime });
  t.after(() => store.close());
  const scope = { project: "naut", namespace: "operations" };
  const record = await store.put({ content: "The relay listens on port 8788.", tags: ["network", "relay"] }, scope);
  assert.equal((await store.search("relay port", scope))[0].record.id, record.id);
  await store.update(record.id, { content: "The bridge listens on socket 9999.", tags: ["bridge"] }, scope, { expectedVersion: 1 });
  assert.deepEqual(await store.search("relay", scope), []);
  assert.equal((await store.search("bridge socket", scope))[0].record.id, record.id);
  await store.delete(record.id, scope, { expectedVersion: 2 });
  assert.deepEqual(await store.search("bridge", scope), []);
});

test("SQLite mutation batches and namespace quotas roll back records and FTS together", async (t) => {
  const { root, runtime } = fixture(t);
  const store = createSqliteMemoryStore({
    file: sqliteMemoryFilePath(root),
    projectId: "naut",
    runtime,
    namespaceQuotaBytes: { architecture: 500 },
  });
  t.after(() => store.close());
  const scope = { project: "naut", namespace: "architecture" };
  await assert.rejects(store.apply([
    { operation: "put", scope, record: { content: "rollback sentinel" } },
    { operation: "put", scope, record: { content: "X".repeat(1000) } },
  ]), /namespace quota exceeded/);
  assert.deepEqual(await store.search("sentinel", scope), []);
  assert.equal((await store.stats(scope)).recordCount, 0);
});

test("an over-quota SQLite store still permits memory-reducing maintenance", async (t) => {
  const { root, runtime } = fixture(t);
  const file = sqliteMemoryFilePath(root);
  const scope = { project: "naut", namespace: "archive" };
  const initial = createSqliteMemoryStore({ file, projectId: "naut", runtime });
  const record = await initial.put({ content: `Large archived note ${"X".repeat(8000)}` }, scope);
  const physicalBytes = (await initial.stats(scope)).physicalBytes;
  initial.close();
  const constrained = createSqliteMemoryStore({ file, projectId: "naut", runtime, quotaBytes: physicalBytes - 1 });
  t.after(() => constrained.close());
  const compressed = await constrained.update(
    record.id,
    { content: "Compressed archived note." },
    scope,
    { expectedVersion: 1 },
  );
  assert.ok(compressed.logicalBytes < record.logicalBytes);
});

test("independent SQLite connections share WAL-backed records", async (t) => {
  const { root, runtime } = fixture(t);
  const file = sqliteMemoryFilePath(root);
  const first = createSqliteMemoryStore({ file, projectId: "naut", runtime });
  const second = createSqliteMemoryStore({ file, projectId: "naut", runtime });
  t.after(() => first.close());
  t.after(() => second.close());
  await Promise.all([
    first.put({ content: "Written by connection one." }, { project: "naut" }),
    second.put({ content: "Written by connection two." }, { project: "naut" }),
  ]);
  assert.equal((await first.list({ project: "naut" })).length, 2);
  assert.ok((await second.stats({ project: "naut" })).physicalBytes > 0);
});

test("JSON migration preserves identity and versions, is idempotent, and leaves its source untouched", async (t) => {
  const { root, runtime } = fixture(t);
  const sourceFile = memoryFilePath(root);
  const destinationFile = sqliteMemoryFilePath(root);
  const source = createFileMemoryStore({ file: sourceFile, projectId: "naut", runtime });
  const scope = { project: "naut", namespace: "architecture" };
  const original = await source.put({ content: "Use JSON during the prototype.", kind: "decision" }, scope);
  await source.update(original.id, { content: "Use SQLite after the prototype." }, scope, { expectedVersion: 1 });
  await source.put({ content: "The user prefers concise reports.", kind: "preference" }, { project: "naut" });
  const before = readFileSync(sourceFile);
  const first = await migrateFileMemoryStoreToSqlite({ sourceFile, destinationFile, projectId: "naut", runtime });
  assert.deepEqual({ imported: first.imported, skipped: first.skipped, total: first.total }, { imported: 2, skipped: 0, total: 2 });
  assert.deepEqual(readFileSync(sourceFile), before);
  const migrated = createSqliteMemoryStore({ file: destinationFile, projectId: "naut", runtime });
  const record = await migrated.get(original.id, scope);
  assert.equal(record.version, 2);
  assert.equal(record.content, "Use SQLite after the prototype.");
  assert.equal((await migrated.search("SQLite prototype", scope))[0].record.id, original.id);
  migrated.close();
  const second = await migrateFileMemoryStoreToSqlite({ sourceFile, destinationFile, projectId: "naut", runtime });
  assert.deepEqual({ imported: second.imported, skipped: second.skipped, total: second.total }, { imported: 0, skipped: 2, total: 2 });
});

test("project store selection keeps JSON as default and opts into the SQLite path explicitly", (t) => {
  const { root, runtime } = fixture(t);
  const json = createProjectMemoryStore(root, { projectId: "naut", runtime });
  const sqlite = createProjectMemoryStore(root, { projectId: "naut", runtime, backend: "sqlite" });
  t.after(() => sqlite.close());
  assert.equal(json.file, memoryFilePath(root));
  assert.equal(sqlite.file, sqliteMemoryFilePath(root));
  assert.equal(sqlite.backend, "sqlite");
  assert.throws(() => createProjectMemoryStore(root, { projectId: "naut", backend: "unknown" }), /backend must be/);
});
