// Guards that bound a tree rather than a branch. `max_depth` cannot express any of
// this: it limits how long one path gets, while the failure mode at depth 12 is
// width — half a million nodes, none of them violating the depth limit.
//
// Every guard here is shared state between processes, so the tests exercise the same
// ledger from several concurrent callers rather than trusting a single sequence.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  admitTreeNode,
  createRuntime,
  readTreeLedger,
  releaseTreeNode,
  treeGuardsEnabled,
  treeLimits,
  withFileLock,
} from "../../src/index.js";

const ledgerFile = () => path.join(mkdtempSync(path.join(tmpdir(), "mind-tree-")), "tree.json");

// The counter is module-level on purpose. Ids must be unique across *runtimes*, not
// just within one, because separate runtimes here stand in for separate processes —
// which in production mint UUIDs. A per-runtime counter would hand every process the
// same id and silently break both the ancestor walk and slot release.
let nodeSequence = 0;
const testRuntime = (overrides = {}) =>
  createRuntime({
    now: () => Date.UTC(2026, 0, 1),
    randomId: () => `node${++nodeSequence}`,
    env: {},
    pid: 4242,
    isProcessAlive: () => true,
    ...overrides,
  });

const admit = (file, limits, extra = {}) =>
  admitTreeNode({
    file,
    treeId: "t1",
    limits,
    runtime: extra.runtime || testRuntime(),
    admissionTimeoutMs: 250,
    pollMs: 5,
    ...extra,
  });

// --- the node budget ------------------------------------------------------------

test("a tree stops spawning once its node budget is spent", async () => {
  const file = ledgerFile();
  const runtime = testRuntime();
  const limits = { maxNodes: 3, maxTokens: null, maxConcurrent: null };
  for (let i = 0; i < 3; i++) await releaseTreeNode(await admit(file, limits, { runtime }));
  await assert.rejects(() => admit(file, limits, { runtime }), /tree node budget exhausted: 3\/3/);
});

test("the node budget counts completed nodes, not just running ones", async () => {
  const file = ledgerFile();
  const runtime = testRuntime();
  const limits = { maxNodes: 2, maxTokens: null, maxConcurrent: null };
  // Releasing a slot returns concurrency, never budget — otherwise a sequential tree
  // would be unbounded, which is exactly the runaway case.
  await releaseTreeNode(await admit(file, limits, { runtime }));
  await releaseTreeNode(await admit(file, limits, { runtime }));
  assert.equal(readTreeLedger(file).live.length, 0);
  await assert.rejects(() => admit(file, limits, { runtime }), /node budget exhausted/);
});

test("the budget is shared across branches that never see each other", async () => {
  const file = ledgerFile();
  const limits = { maxNodes: 5, maxTokens: null, maxConcurrent: null };
  // Separate runtimes stand in for separate processes: no shared memory, only the file.
  const admits = Array.from({ length: 5 }, () => admit(file, limits, { runtime: testRuntime() }));
  await Promise.all(admits);
  assert.equal(readTreeLedger(file).nodes_admitted, 5);
  await assert.rejects(() => admit(file, limits, { runtime: testRuntime() }), /node budget exhausted/);
});

// --- the token budget -----------------------------------------------------------

test("tokens are charged on release and stop the next spawn", async () => {
  const file = ledgerFile();
  const runtime = testRuntime();
  const limits = { maxNodes: null, maxTokens: 1000, maxConcurrent: null };
  await releaseTreeNode(await admit(file, limits, { runtime }), 400);
  await releaseTreeNode(await admit(file, limits, { runtime }), 700);
  assert.equal(readTreeLedger(file).tokens_spent, 1100);
  // Accounting is after the fact — the node that crossed the line still ran. The
  // guard stops the tree from continuing past it, which is the achievable promise.
  await assert.rejects(() => admit(file, limits, { runtime }), /tree token budget exhausted: 1100\/1000/);
});

// --- concurrency ----------------------------------------------------------------

test("concurrent siblings are capped", async () => {
  const file = ledgerFile();
  const limits = { maxNodes: null, maxTokens: null, maxConcurrent: 2 };
  const parent = await admit(file, limits);
  const a = await admit(file, limits, { parentNodeId: parent.nodeId });
  await admit(file, limits, { parentNodeId: parent.nodeId });
  await assert.rejects(
    () => admit(file, limits, { parentNodeId: parent.nodeId }),
    /timed out waiting for a concurrency slot/,
  );
  // Freeing one lets the next in.
  await releaseTreeNode(a);
  const c = await admit(file, limits, { parentNodeId: parent.nodeId });
  assert.ok(c.nodeId);
});

test("a chain deeper than the cap still makes progress", async () => {
  // The deadlock this guard would otherwise cause: with a cap of 2, a chain of 5
  // would have every slot held by an ancestor that cannot finish until its own
  // descendant runs, and the descendant can never be admitted. An ancestor waiting
  // on a child is a suspended frame, not work, so it is excluded from the count.
  const file = ledgerFile();
  const limits = { maxNodes: null, maxTokens: null, maxConcurrent: 2 };
  let parentNodeId = null;
  for (let depth = 0; depth < 5; depth++) {
    const handle = await admit(file, limits, { parentNodeId, depth });
    parentNodeId = handle.nodeId;
  }
  assert.equal(readTreeLedger(file).live.length, 5, "all five are live despite a cap of 2");
});

test("a sibling of a deep chain is still capped", async () => {
  // Excluding ancestors must not exclude everything: work that is genuinely parallel
  // to the spawner still counts.
  const file = ledgerFile();
  const limits = { maxNodes: null, maxTokens: null, maxConcurrent: 2 };
  const root = await admit(file, limits);
  const branchA = await admit(file, limits, { parentNodeId: root.nodeId });
  const branchB = await admit(file, limits, { parentNodeId: root.nodeId });
  // branchA's child sees root (ancestor, excluded) and branchB (parallel, counted),
  // plus branchA itself (ancestor, excluded) — one working, under the cap.
  const deep = await admit(file, limits, { parentNodeId: branchA.nodeId });
  assert.ok(deep.nodeId);
  // A third top-level branch sees branchA, branchB and deep all as parallel work.
  await assert.rejects(
    () => admit(file, limits, { parentNodeId: root.nodeId }),
    /timed out waiting for a concurrency slot/,
  );
  assert.equal(readTreeLedger(file).live.length, 4);
  await releaseTreeNode(branchB);
});

test("a crashed Alter's slot is reclaimed rather than lost", async () => {
  const file = ledgerFile();
  const limits = { maxNodes: null, maxTokens: null, maxConcurrent: 1 };
  const dead = testRuntime({ pid: 999 });
  await admit(file, limits, { runtime: dead });
  // The holder is gone without ever releasing; a cap of 1 would wedge the tree
  // permanently if liveness were never rechecked.
  const survivor = testRuntime({ pid: 4242, isProcessAlive: (pid) => pid !== 999 });
  const next = await admit(file, limits, { runtime: survivor });
  assert.ok(next.nodeId);
  assert.deepEqual(readTreeLedger(file).live.map((e) => e.pid), [4242]);
});

// --- fail-closed and opt-out -----------------------------------------------------

test("guards are off only when every limit is null", () => {
  assert.equal(treeGuardsEnabled(treeLimits({})), false);
  assert.equal(treeGuardsEnabled(treeLimits({ max_tree_nodes: 10 })), true);
  assert.equal(treeGuardsEnabled(treeLimits({ max_concurrent_alters: 2 })), true);
  assert.deepEqual(treeLimits({ max_tree_nodes: 8, max_tree_tokens: 9, max_concurrent_alters: 7 }), {
    maxNodes: 8,
    maxTokens: 9,
    maxConcurrent: 7,
  });
});

test("an unreadable ledger fails closed instead of resetting the ceiling", async () => {
  const file = ledgerFile();
  writeFileSync(file, "{ not json");
  await assert.rejects(
    () => admit(file, { maxNodes: 1, maxTokens: null, maxConcurrent: null }),
    /tree ledger is not valid JSON/,
  );
});

test("releasing a handle that was never taken is a no-op", async () => {
  assert.equal(await releaseTreeNode(null), null);
});

// --- the lock the whole thing rests on -------------------------------------------

test("the file lock serializes read-modify-write across callers", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mind-lock-")), "counter.json");
  writeFileSync(file, JSON.stringify({ n: 0 }));
  // Without the lock these interleave: each reads the same n and writes n+1, so the
  // counter lands far below 20 even though every individual write was atomic.
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withFileLock(file, async () => {
        const current = JSON.parse(readFileSync(file, "utf8")).n;
        await new Promise((resolve) => setTimeout(resolve, 1));
        writeFileSync(file, JSON.stringify({ n: current + 1 }));
      }),
    ),
  );
  assert.equal(JSON.parse(readFileSync(file, "utf8")).n, 20);
  assert.ok(!existsSync(`${file}.lock`), "the lock is released even on the happy path");
});

test("the file lock is released when the operation throws", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mind-lock-")), "x.json");
  await assert.rejects(() => withFileLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.ok(!existsSync(`${file}.lock`));
  // Still usable afterwards.
  assert.equal(await withFileLock(file, () => "ok"), "ok");
});
