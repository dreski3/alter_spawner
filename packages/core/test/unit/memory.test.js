import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFileMemoryStore,
  createProjectMemoryStore,
  memoryFilePath,
} from "@mind/core";

const createFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-memory-"));
  let currentTime = Date.parse("2026-08-03T10:00:00.000Z");
  let nextId = 0;
  const runtime = {
    now: () => currentTime,
    randomId: () => String(nextId += 1).padStart(16, "0"),
    env: {},
  };
  const store = createProjectMemoryStore(root, { projectId: "naut", runtime });
  return {
    root,
    runtime,
    store,
    setTime: (value) => { currentTime = Date.parse(value); },
  };
};

test("project memory persists normalized records atomically", async () => {
  const fixture = createFixture();
  const scope = { project: "naut" };
  const stored = await fixture.store.put({
    kind: "fact",
    content: "The relay listens on port 8788.",
    tags: ["relay", "configuration", "relay"],
    source: { runId: "run_1", messageIds: ["msg_1"] },
    confidence: 0.9,
  }, scope);
  assert.equal(stored.id, "mem_0000000000000001");
  assert.deepEqual(stored.tags, ["configuration", "relay"]);
  assert.equal(stored.version, 1);
  assert.equal(memoryFilePath(fixture.root), fixture.store.file);
  const reopened = createFileMemoryStore({ file: fixture.store.file, projectId: "naut", runtime: fixture.runtime });
  assert.deepEqual(await reopened.get(stored.id, scope), stored);
  const document = JSON.parse(readFileSync(fixture.store.file, "utf8"));
  assert.equal(document.schema_version, 1);
  assert.equal(document.records.length, 1);
});

test("memory visibility follows project, catalog, and conversation scopes", async () => {
  const { store } = createFixture();
  const project = { project: "naut" };
  const catalog = { project: "naut", catalog: "reviewer" };
  const conversation = { project: "naut", catalog: "reviewer", conversation: "chat_1" };
  const projectRecord = await store.put({ content: "Project build uses npm." }, project);
  const catalogRecord = await store.put({ content: "Reviewer prefers terse findings." }, catalog);
  const conversationRecord = await store.put({ content: "This chat concerns memory scopes." }, conversation);
  assert.equal((await store.get(projectRecord.id, conversation)).id, projectRecord.id);
  assert.equal((await store.get(catalogRecord.id, conversation)).id, catalogRecord.id);
  assert.equal((await store.get(conversationRecord.id, catalog)), null);
  assert.equal((await store.get(catalogRecord.id, project)), null);
  await assert.rejects(store.delete(projectRecord.id, conversation), /not found/);
  await assert.rejects(store.put({ content: "Wrong project." }, { project: "other" }), /must match store project/);
});

test("memory search ranks matching active records and supports filters", async () => {
  const fixture = createFixture();
  const scope = { project: "naut", catalog: "operator" };
  await fixture.store.put({
    kind: "fact",
    content: "The relay listens on port 8788.",
    tags: ["relay", "network"],
  }, { project: "naut" });
  await fixture.store.put({
    kind: "decision",
    content: "Use port 8788 for local bridge traffic.",
    tags: ["relay"],
  }, scope);
  await fixture.store.put({
    kind: "fact",
    content: "An expired relay note.",
    tags: ["relay"],
    expiresAt: "2026-08-03T09:00:00.000Z",
  }, scope);
  const results = await fixture.store.search("relay port 8788", scope, { limit: 5, tags: ["relay"] });
  assert.equal(results.length, 2);
  assert.equal(results[0].record.content, "The relay listens on port 8788.");
  assert.deepEqual(results[0].matchedTerms, ["relay", "port", "8788"]);
  const decisions = await fixture.store.search("port", scope, { kinds: ["decision"] });
  assert.deepEqual(decisions.map((result) => result.record.kind), ["decision"]);
});

test("memory updates use optimistic versions and deletes require exact scope", async () => {
  const { store } = createFixture();
  const scope = { project: "naut", catalog: "reviewer" };
  const original = await store.put({ content: "Prefer long reports.", kind: "preference" }, scope);
  const updated = await store.update(original.id, { content: "Prefer concise reports." }, scope, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.equal(updated.content, "Prefer concise reports.");
  await assert.rejects(
    store.update(original.id, { content: "Stale update." }, scope, { expectedVersion: 1 }),
    /version conflict/,
  );
  await assert.rejects(store.delete(original.id, { project: "naut" }), /not found/);
  const removed = await store.delete(original.id, scope, { expectedVersion: 2 });
  assert.equal(removed.id, original.id);
  assert.equal(await store.get(original.id, scope), null);
});

test("identical active memories deduplicate and expired memories can be replaced", async () => {
  const fixture = createFixture();
  const scope = { project: "naut" };
  const first = await fixture.store.put({ content: "Remember this." }, scope);
  const duplicate = await fixture.store.put({ content: "Remember this." }, scope);
  assert.equal(duplicate.id, first.id);
  await fixture.store.put({ content: "Temporary note.", expiresAt: "2026-08-03T11:00:00.000Z" }, scope);
  fixture.setTime("2026-08-03T12:00:00.000Z");
  const replacement = await fixture.store.put({ content: "Temporary note.", expiresAt: "2026-08-04T00:00:00.000Z" }, scope);
  assert.notEqual(replacement.id, "mem_0000000000000002");
});

test("independent store instances serialize concurrent writes", async () => {
  const fixture = createFixture();
  let nextId = 100;
  const runtime = {
    ...fixture.runtime,
    randomId: () => String(nextId += 1).padStart(16, "0"),
  };
  const second = createFileMemoryStore({ file: fixture.store.file, projectId: "naut", runtime });
  await Promise.all([
    fixture.store.put({ content: "Written by the first store." }, { project: "naut" }),
    second.put({ content: "Written by the second store." }, { project: "naut" }),
  ]);
  const document = JSON.parse(readFileSync(fixture.store.file, "utf8"));
  assert.equal(document.records.length, 2);
});

test("invalid memory documents fail closed", async () => {
  const fixture = createFixture();
  await fixture.store.put({ content: "A valid record first." }, { project: "naut" });
  writeFileSync(fixture.store.file, "not-json");
  await assert.rejects(fixture.store.get("mem_1", { project: "naut" }), /not valid JSON/);
});

test("memory mutation batches commit atomically", async () => {
  const fixture = createFixture();
  const scope = { project: "naut" };
  await assert.rejects(fixture.store.apply([
    { operation: "put", scope, record: { content: "This must roll back." } },
    { operation: "update", scope, id: "mem_missing", patch: { content: "Missing." } },
  ]), /not found/);
  assert.deepEqual(await fixture.store.search("roll back", scope), []);
});

test("memory namespaces isolate sections and report native storage accounting", async () => {
  const fixture = createFixture();
  const architecture = { project: "naut", namespace: "architecture" };
  const operations = { project: "naut", namespace: "operations" };
  const first = await fixture.store.put({ content: "Use SQLite for indexed memory." }, architecture);
  await fixture.store.put({ content: "The relay listens on port 8788." }, operations);
  assert.equal((await fixture.store.search("SQLite", architecture)).length, 1);
  assert.equal((await fixture.store.search("SQLite", operations)).length, 0);
  assert.equal(await fixture.store.get(first.id, operations), null);
  const stats = await fixture.store.stats({ project: "naut" });
  assert.equal(stats.recordCount, 2);
  assert.equal(stats.byNamespace.operations.records, 1);
  const architectureStats = await fixture.store.stats(architecture);
  assert.equal(architectureStats.recordCount, 1);
  assert.equal(architectureStats.byNamespace.architecture.records, 1);
  assert.equal(architectureStats.logicalBytes, first.logicalBytes);
  assert.ok(architectureStats.physicalBytes >= architectureStats.logicalBytes);
});

test("memory quotas reject an entire atomic mutation before it reaches disk", async () => {
  const fixture = createFixture();
  const constrained = createFileMemoryStore({
    file: fixture.store.file,
    projectId: "naut",
    runtime: fixture.runtime,
    namespaceQuotaBytes: { architecture: 100 },
  });
  await assert.rejects(
    constrained.put({ content: "A".repeat(500) }, { project: "naut", namespace: "architecture" }),
    /namespace quota exceeded/,
  );
  assert.equal(existsSync(fixture.store.file), false);
});
