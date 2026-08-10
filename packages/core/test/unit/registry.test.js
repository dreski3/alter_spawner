// The registry exists because the daemon lives outside every root and so needs *some*
// list of what to tick. The design property under test throughout is that it is an
// index, not a source of truth: every assertion about `agents.json` is paired with one
// showing a rescan reproduces it, and deleting it costs nothing but that rescan.
//
// Everything here runs against a temp MIND_HOME and temp workspaces, so no test can see
// or touch the developer's real ~/.mind.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addRegistryInput,
  createRuntime,
  defaultWorkspaces,
  discoverMindRoots,
  ensureAgentIdentity,
  ensureRegistry,
  listMinds,
  mindHomeDir,
  readRegistry,
  readRegistryConfig,
  registryPath,
  removeRegistryInput,
  resolveMind,
  scanRegistry,
  touchMind,
  writeRegistryConfig,
} from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);
const runtime = (overrides = {}) => createRuntime({ now: () => FROZEN, env: {}, ...overrides });

// One temp dir per test holding both the fake MIND_HOME and the workspace it scans.
const sandbox = () => {
  const base = mkdtempSync(path.join(tmpdir(), "mind-registry-"));
  const env = { MIND_HOME: path.join(base, ".mind"), HOME: base };
  const workspace = path.join(base, "minds");
  mkdirSync(workspace, { recursive: true });
  return { base, env, workspace };
};

const mind = (parent, name, config = {}) => {
  const root = path.join(parent, name);
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ catalog_dir: "catalog", ...config }));
  return root;
};

const identified = (parent, name, agentId) => mind(parent, name, { agent_id: agentId, name });

test("MIND_HOME overrides the default location, and the default is ~/.mind", () => {
  const { env, base } = sandbox();
  assert.equal(mindHomeDir(env), path.join(base, ".mind"));
  assert.equal(mindHomeDir({ HOME: "/home/someone" }), path.join("/home/someone", ".mind"));
  assert.deepEqual(defaultWorkspaces({ HOME: "/home/someone" }), [path.join("/home/someone", "minds")]);
});

test("a first run has no config and defaults to the ~/minds workspace", () => {
  const { env, base } = sandbox();
  assert.deepEqual(readRegistryConfig(env), { workspaces: [path.join(base, "minds")], roots: [] });
});

test("discovery finds minds in a workspace and stops descending at each one", () => {
  const { workspace } = sandbox();
  const chronicler = mind(workspace, "chronicler");
  const scribe = mind(workspace, "scribe");
  // A nestable Alter's home is a root for its children, but it is a run artifact rather
  // than a mind — the walk must never surface it.
  mind(path.join(chronicler, ".alters", "runs"), "20260806T120000Z_child");
  // A mind nested inside a mind's ordinary subdirectory is likewise not a second mind.
  mind(chronicler, "notes");

  assert.deepEqual(discoverMindRoots(workspace).sort(), [chronicler, scribe].sort());
});

test("discovery skips node_modules and respects a depth bound", () => {
  const { workspace } = sandbox();
  mind(path.join(workspace, "node_modules", "pkg"), "vendored");
  const deep = mind(path.join(workspace, "a", "b", "c"), "buried");

  assert.deepEqual(discoverMindRoots(workspace), []);
  assert.deepEqual(discoverMindRoots(workspace, { maxDepth: 5 }), [deep]);
});

test("a scan builds the index, keyed by agent_id", async () => {
  const { env, workspace } = sandbox();
  identified(workspace, "chronicler", "a".repeat(32));
  identified(workspace, "scribe", "b".repeat(32));

  const result = await scanRegistry({ env, runtime: runtime() });
  assert.deepEqual(Object.keys(result.index.agents).sort(), ["a".repeat(32), "b".repeat(32)]);
  assert.equal(result.index.agents["a".repeat(32)].name, "chronicler");
  assert.equal(result.index.agents["a".repeat(32)].last_seen, "2026-08-06T12:00:00.000Z");

  const onDisk = JSON.parse(readFileSync(registryPath(env), "utf8"));
  assert.deepEqual(onDisk, result.index);
});

test("deleting the index costs nothing but a rescan", async () => {
  const { env, workspace } = sandbox();
  identified(workspace, "chronicler", "a".repeat(32));
  const before = (await scanRegistry({ env, runtime: runtime() })).index;

  rmSync(registryPath(env));
  assert.equal(readRegistry(env), null, "gone, and reported as gone rather than as empty");

  // Not a repair step a user has to know about: reading heals it.
  const after = await ensureRegistry({ env, runtime: runtime() });
  assert.deepEqual(after, before);
});

test("a scan drops minds that are no longer on disk", async () => {
  const { env, workspace } = sandbox();
  const chronicler = identified(workspace, "chronicler", "a".repeat(32));
  identified(workspace, "scribe", "b".repeat(32));
  await scanRegistry({ env, runtime: runtime() });

  rmSync(chronicler, { recursive: true });
  const result = await scanRegistry({ env, runtime: runtime() });
  assert.deepEqual(Object.keys(result.index.agents), ["b".repeat(32)]);
});

test("a scan adopts a root that has no identity yet, and reports it", async () => {
  const { env, workspace } = sandbox();
  const bare = mind(workspace, "legacy");

  const result = await scanRegistry({ env, runtime: runtime({ randomId: () => "c".repeat(32) }) });
  assert.deepEqual(result.adopted, [{ root: bare, agentId: "c".repeat(32), name: "legacy" }]);
  assert.equal(Object.keys(result.index.agents)[0], "c".repeat(32));
  // The mint landed in the mind's own config, so a second scan is a no-op.
  const again = await scanRegistry({ env, runtime: runtime({ randomId: () => "d".repeat(32) }) });
  assert.deepEqual(again.adopted, []);
  assert.deepEqual(Object.keys(again.index.agents), ["c".repeat(32)]);
});

test("--no-adopt leaves an unidentified root alone and out of the index", async () => {
  const { env, workspace } = sandbox();
  mind(workspace, "legacy");
  const result = await scanRegistry({ env, runtime: runtime(), adopt: false });
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.index.agents, {});
});

test("two roots claiming one agent_id are reported, not silently merged", async () => {
  const { env, workspace } = sandbox();
  // What `cp -r` of a mind produces: the copy carries the original's identity.
  const original = identified(workspace, "chronicler", "a".repeat(32));
  const copy = mind(workspace, "chronicler-copy", { agent_id: "a".repeat(32), name: "chronicler" });

  const result = await scanRegistry({ env, runtime: runtime() });
  assert.equal(Object.keys(result.index.agents).length, 1);
  assert.deepEqual(result.conflicts, [{ agentId: "a".repeat(32), kept: original, ignored: copy }]);
  assert.equal(result.index.agents["a".repeat(32)].root, original, "first by scan order wins, deterministically");
});

// The conflict above is only actionable if a forked mind can be re-identified. `mind init
// --force --new-identity` does that by clearing the recorded identity before the merge;
// this is the core-level equivalent, and it exists so the invariant it deliberately
// breaks — never remint — stays visible in a test rather than only in a CLI flag.
test("clearing a copy's identity resolves the conflict and cuts it off from the original's store", async () => {
  const { env, workspace } = sandbox();
  const original = identified(workspace, "chronicler", "a".repeat(32));
  const copy = mind(workspace, "chronicler-copy", { agent_id: "a".repeat(32), name: "chronicler" });

  writeFileSync(
    path.join(copy, ".alters", "config.json"),
    JSON.stringify({ catalog_dir: "catalog", name: "chronicler-fork" }),
  );
  const reidentified = ensureAgentIdentity(copy, { runtime: runtime({ randomId: () => "f".repeat(32) }) });
  assert.equal(reidentified.agentId, "f".repeat(32));

  const result = await scanRegistry({ env, runtime: runtime() });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.index.agents["a".repeat(32)].root, original);
  assert.equal(result.index.agents["f".repeat(32)].root, copy);
});

test("an explicit root outside any workspace is registered, and a dead one is reported", async () => {
  const { env, base, workspace } = sandbox();
  const elsewhere = identified(path.join(base, "not-a-workspace"), "hermit", "e".repeat(32));
  const ghost = path.join(base, "deleted-mind");
  writeRegistryConfig({ workspaces: [workspace], roots: [elsewhere, ghost] }, env);

  const result = await scanRegistry({ env, runtime: runtime() });
  assert.equal(result.index.agents["e".repeat(32)].root, elsewhere);
  assert.deepEqual(result.missing, [ghost]);
});

test("last_seen survives a rescan but moves when the mind is touched", async () => {
  const { env, workspace } = sandbox();
  identified(workspace, "chronicler", "a".repeat(32));
  await scanRegistry({ env, runtime: runtime() });

  const later = FROZEN + 3600_000;
  await scanRegistry({ env, runtime: runtime({ now: () => later }) });
  assert.equal(
    readRegistry(env).agents["a".repeat(32)].last_seen,
    "2026-08-06T12:00:00.000Z",
    "a scan is not a sighting — otherwise last_seen only ever means 'when did I last scan'",
  );

  const touched = await touchMind("a".repeat(32), { env, runtime: runtime({ now: () => later }) });
  assert.equal(touched.last_seen, "2026-08-06T13:00:00.000Z");
  assert.equal(await touchMind("f".repeat(32), { env, runtime: runtime() }), null);
});

test("a mind resolves by agent_id or by name", async () => {
  const { env, workspace } = sandbox();
  const chronicler = identified(workspace, "chronicler", "a".repeat(32));

  assert.equal((await resolveMind("a".repeat(32), { env, runtime: runtime() })).root, chronicler);
  assert.equal((await resolveMind("chronicler", { env, runtime: runtime() })).agentId, "a".repeat(32));
  await assert.rejects(resolveMind("nobody", { env, runtime: runtime() }), /no mind named "nobody"/);
});

test("an ambiguous name is an error rather than a guess", async () => {
  const { env, workspace } = sandbox();
  mind(path.join(workspace, "work"), "scribe", { agent_id: "a".repeat(32), name: "scribe" });
  mind(path.join(workspace, "backup"), "scribe", { agent_id: "b".repeat(32), name: "scribe" });

  await assert.rejects(
    resolveMind("scribe", { env, runtime: runtime() }),
    /names more than one mind .* use its agent_id/,
  );
  // The ids still resolve — only the mutable, human half of identity is ambiguous.
  assert.match((await resolveMind("a".repeat(32), { env, runtime: runtime() })).root, /work\/scribe$/);
});

test("a stale index entry heals itself on resolve", async () => {
  const { env, workspace } = sandbox();
  identified(workspace, "chronicler", "a".repeat(32));
  const scribe = identified(workspace, "scribe", "b".repeat(32));
  await scanRegistry({ env, runtime: runtime() });

  // The mind moved out from under a registry nobody rescanned.
  rmSync(scribe, { recursive: true });
  const moved = identified(workspace, "scribe-moved", "b".repeat(32));

  const resolved = await resolveMind("b".repeat(32), { env, runtime: runtime() });
  assert.equal(resolved.root, moved, "one rescan, then the answer — no manual repair step");
  await assert.rejects(resolveMind("scribe", { env, runtime: runtime() }), /no mind named "scribe"/);
});

test("registry inputs can be added and dropped without touching the minds", async () => {
  const { env, base, workspace } = sandbox();
  const hermit = identified(path.join(base, "elsewhere"), "hermit", "e".repeat(32));
  writeRegistryConfig({ workspaces: [workspace], roots: [] }, env);

  await scanRegistry({ env, runtime: runtime() });

  assert.deepEqual(addRegistryInput("root", hermit, env), { added: true, path: hermit, target: "roots" });
  assert.equal(addRegistryInput("root", hermit, env).added, false, "adding twice is idempotent");
  assert.deepEqual(readRegistryConfig(env).roots, [hermit]);
  assert.equal(
    (await listMinds({ env, runtime: runtime() })).length,
    0,
    "an index that exists is served as-is — only an absent one triggers a scan",
  );

  await scanRegistry({ env, runtime: runtime() });
  assert.deepEqual((await listMinds({ env, runtime: runtime() })).map((m) => m.name), ["hermit"]);

  assert.equal(removeRegistryInput(hermit, env).removed, true);
  assert.equal(removeRegistryInput(hermit, env).removed, false);
  await scanRegistry({ env, runtime: runtime() });
  assert.deepEqual(await listMinds({ env, runtime: runtime() }), []);
  assert.equal(ensureAgentIdentity(hermit).agentId, "e".repeat(32), "the mind itself was never touched");
});
