// A mind's identity used to be its directory basename, which makes identity a property
// of the filesystem rather than of the mind: `mv ~/minds/scribe ~/archive/scribe`
// orphaned every memory record it owned, and two directories that happened to share a
// basename shared a store id. `agent_id` is minted once and never derived from the path;
// `name` is the mutable human handle, which is the entire reason they are two fields.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProjectMemoryStore,
  createRuntime,
  ensureAgentIdentity,
  mintAgentId,
  readAgentIdentity,
  readConfig,
  resolveProjectId,
  scaffold,
} from "../../src/index.js";

const workspace = () => mkdtempSync(path.join(tmpdir(), "mind-identity-"));

const projectRoot = (parent, basename, config = {}) => {
  const root = path.join(parent, basename);
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ catalog_dir: "catalog", ...config }));
  return root;
};

const readRawConfig = (root) => JSON.parse(readFileSync(path.join(root, ".alters", "config.json"), "utf8"));

test("a minted id is opaque, 128 bits of hex, and distinct per call", () => {
  const first = mintAgentId();
  const second = mintAgentId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test("a root with no recorded identity reports nulls rather than defaults", () => {
  const root = projectRoot(workspace(), "scribe");
  assert.deepEqual(readAgentIdentity(root), { agentId: null, name: null, memoryProjectId: null });
  // readConfig still fills the field in, which is exactly why readAgentIdentity exists —
  // "absent" and "null" are indistinguishable through the merged view.
  assert.equal(readConfig(root).agent_id, null);
});

test("ensureAgentIdentity mints once, defaults the name to the basename, and is idempotent", () => {
  const root = projectRoot(workspace(), "scribe");
  const first = ensureAgentIdentity(root);
  assert.match(first.agentId, /^[0-9a-f]{32}$/);
  assert.equal(first.name, "scribe");
  assert.equal(first.minted, true);

  const second = ensureAgentIdentity(root, { name: "someone else" });
  assert.equal(second.agentId, first.agentId, "the id must never be reminted");
  assert.equal(second.name, "scribe", "an existing name is not overwritten either");
  assert.equal(second.minted, false);
});

test("ensureAgentIdentity leaves the rest of the config untouched", () => {
  const root = projectRoot(workspace(), "scribe", { max_tree_nodes: 7, retry: { fallback_retries: 3 } });
  ensureAgentIdentity(root);
  const raw = readRawConfig(root);
  assert.equal(raw.max_tree_nodes, 7);
  assert.deepEqual(raw.retry, { fallback_retries: 3 });
  assert.equal(raw.catalog_dir, "catalog");
});

test("a root whose config is missing entirely can still be adopted", () => {
  const root = path.join(workspace(), "orphan");
  mkdirSync(root, { recursive: true });
  const identity = ensureAgentIdentity(root, { name: "adopted" });
  assert.equal(identity.name, "adopted");
  assert.equal(readRawConfig(root).agent_id, identity.agentId);
  // Falling back to DEFAULT_CONFIG rather than writing a bare `{agent_id}` keeps the
  // file a valid project marker, so findProjectRoot can see it.
  assert.equal(readRawConfig(root).catalog_dir, "catalog");
});

test("project id precedence: explicit, then legacy pin, then agent_id, then basename", () => {
  const parent = workspace();
  const bare = projectRoot(parent, "bare");
  assert.equal(resolveProjectId(bare), "bare", "no identity yet — the old basename behaviour");

  const identified = projectRoot(parent, "identified", { agent_id: "a".repeat(32) });
  assert.equal(resolveProjectId(identified), "a".repeat(32));

  const pinned = projectRoot(parent, "pinned", { agent_id: "b".repeat(32), memory_project_id: "naut-desktop" });
  assert.equal(resolveProjectId(pinned), "naut-desktop", "a store that predates agent_id keeps its own id");

  assert.equal(resolveProjectId(pinned, "explicit-wins"), "explicit-wins");
});

test("moving a mind's directory does not orphan its memory", async () => {
  const parent = workspace();
  const root = projectRoot(parent, "scribe");
  ensureAgentIdentity(root);

  const before = createProjectMemoryStore(root);
  await before.put({ content: "the store survives a rename" }, { project: before.projectId });

  const moved = path.join(parent, "scribe-archived");
  renameSync(root, moved);

  // Under the old basename rule this threw: the document says "scribe", the store now
  // computes "scribe-archived", and validateDocument refuses to open it.
  const after = createProjectMemoryStore(moved);
  assert.equal(after.projectId, before.projectId);
  const found = await after.list({ project: after.projectId });
  assert.equal(found.length, 1);
  assert.equal(found[0].content, "the store survives a rename");
});

test("two minds sharing a basename do not share a store id", () => {
  const parent = workspace();
  const a = projectRoot(path.join(parent, "work"), "scribe");
  const b = projectRoot(path.join(parent, "backup"), "scribe");
  ensureAgentIdentity(a);
  ensureAgentIdentity(b);

  assert.equal(path.basename(a), path.basename(b));
  assert.notEqual(resolveProjectId(a), resolveProjectId(b));
  assert.equal(readAgentIdentity(a).name, readAgentIdentity(b).name, "the human name may well collide");
});

test("a run trace records which mind produced it", () => {
  const root = projectRoot(workspace(), "scribe");
  const { agentId } = ensureAgentIdentity(root);
  const runtime = createRuntime({ now: () => Date.UTC(2026, 7, 6, 12), randomId: () => "aaaa", env: {} });

  const options = { id: "summarize", prompt: "x", model: "m" };
  const home = scaffold(root, readConfig(root), options, runtime, { agentFiles: false });
  assert.equal(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).agent_id, agentId);

  // A root that has no identity — a nestable Alter's child kit — records null rather
  // than inventing one.
  const anonymous = projectRoot(workspace(), "child");
  const childHome = scaffold(anonymous, readConfig(anonymous), { ...options }, runtime, { agentFiles: false });
  assert.equal(JSON.parse(readFileSync(path.join(childHome, "alter.json"), "utf8")).agent_id, null);
});

test("identity is injectable so a test can pin it", () => {
  const root = projectRoot(workspace(), "scribe");
  const runtime = createRuntime({ randomId: () => "f".repeat(32), env: {} });
  assert.equal(ensureAgentIdentity(root, { runtime }).agentId, "f".repeat(32));
});
