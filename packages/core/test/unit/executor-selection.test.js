// An executor is a property of the Alter, not of the call site. These tests pin the
// resolution order and the one thing that resolution buys: an adapter that reads
// nothing off disk does not get a home built for it.
//
// Pure and offline — the adapters here are stubs, so no `opencode` process, no model.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyCatalog,
  createSpawnOptions,
  getHarness,
  HARNESS_ADAPTERS,
  parseSpawnArgs,
  registerHarness,
  scaffold,
  spawnAlter,
  validateManifest,
} from "../../src/index.js";

const makeProject = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-executor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ default_model: "test/model", max_depth: 5, retry: { same_harness_retries: 0, fallback_retries: 0 } }),
  );
  return root;
};

// Records what it was asked to do and returns a well-formed adapter result.
const stubAdapter = (extra = {}) => {
  const calls = [];
  const adapter = {
    ...extra,
    run: async (home, prompt, opts) => {
      calls.push({ home, prompt, opts });
      return {
        tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
        text: "done",
        sessionID: null,
        steps: 1,
        exitCode: 0,
        killed: false,
        ok: true,
        budget_exceeded: false,
        empty_output: false,
      };
    },
  };
  return { adapter, calls };
};

const withHarness = (t, name, adapter) => {
  const had = HARNESS_ADAPTERS.has(name);
  const previous = HARNESS_ADAPTERS.get(name);
  registerHarness(name, adapter);
  t.after(() => {
    if (had) HARNESS_ADAPTERS.set(name, previous);
    else HARNESS_ADAPTERS.delete(name);
  });
};

const options = (overrides = {}) =>
  createSpawnOptions({ name: "node", description: "a node", prompt: "go", ...overrides });

// --- registration and resolution -----------------------------------------------

test("an adapter defaults to needing an agent home, so existing adapters are unaffected", (t) => {
  const { adapter } = stubAdapter();
  withHarness(t, "plain-stub", adapter);
  assert.equal(getHarness("plain-stub").needsAgentHome, true);
  assert.equal(getHarness("opencode").needsAgentHome, true);
});

test("an adapter without a run function is refused at registration", () => {
  assert.throws(() => registerHarness("broken", {}), /must provide a run function/);
  assert.equal(HARNESS_ADAPTERS.has("broken"), false);
});

test("an unknown executor names the ones that do exist", () => {
  assert.throws(() => getHarness("llm"), /unknown executor: llm — registered executors are: .*opencode/);
});

// --- the Alter's declaration wins ----------------------------------------------

test("a declared executor beats the call-site default", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = stubAdapter();
  withHarness(t, "declared", adapter);
  // graph.js and the bridge both pass a harness of their own; a function node must
  // not be dragged onto it just because the caller had a default.
  const { result } = await spawnAlter(root, options({ executor: "declared" }), { harness: "opencode" });
  assert.equal(calls.length, 1);
  assert.equal(result.executor, "declared");
});

test("an Alter that declares nothing follows the call site, then falls back to opencode", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = stubAdapter();
  withHarness(t, "fallback-stub", adapter);
  const { result } = await spawnAlter(root, options(), { harness: "fallback-stub" });
  assert.equal(calls.length, 1);
  assert.equal(result.executor, "fallback-stub");
  assert.equal(createSpawnOptions({}).executor, null, "undeclared is the default");
});

test("the resolved executor is recorded on disk, so re-running a home reaches for it again", async (t) => {
  const root = makeProject(t);
  const { adapter } = stubAdapter();
  withHarness(t, "recorded", adapter);
  const { home } = await spawnAlter(root, options({ executor: "recorded" }), {});
  assert.equal(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).executor, "recorded");
  assert.equal(JSON.parse(readFileSync(path.join(home, "result.json"), "utf8")).executor, "recorded");
});

test("an unknown executor fails before anything is written to disk", async (t) => {
  const root = makeProject(t);
  await assert.rejects(() => spawnAlter(root, options({ executor: "nope" }), {}), /unknown executor: nope/);
  assert.ok(!existsSync(path.join(root, ".alters", "runs")), "no run folder should survive a failed resolution");
});

// --- what the declaration buys --------------------------------------------------

test("an adapter that needs no agent home gets a run record and nothing else", async (t) => {
  const root = makeProject(t);
  const { adapter, calls } = stubAdapter({ needsAgentHome: false });
  withHarness(t, "homeless", adapter);
  const { home, result } = await spawnAlter(root, options({ executor: "homeless" }), {});

  // Kept: the trace every executor shares.
  assert.ok(existsSync(path.join(home, "alter.json")));
  assert.ok(existsSync(path.join(home, "result.json")));
  assert.equal(result.text, "done");

  // Skipped: everything only a coding harness reads off disk.
  for (const artifact of ["AGENTS.md", ".opencode", ".git"]) {
    assert.ok(!existsSync(path.join(home, artifact)), `${artifact} should not be built for a homeless adapter`);
  }
  assert.equal(calls[0].home, home, "it still runs against the folder, it just is not scaffolded");
});

test("a homeless adapter is never asked to have its agent definition rewritten", async (t) => {
  const root = makeProject(t);
  const { adapter } = stubAdapter({ needsAgentHome: false });
  withHarness(t, "homeless-retry", adapter);
  // retry.js rewrites `.opencode/agents/alter.md` on a model swap; there is no such
  // file here, so the swap path must be disabled rather than left to throw.
  const { home } = await spawnAlter(
    root,
    options({ executor: "homeless-retry", fallbackModel: "other/model" }),
    {},
  );
  assert.ok(!existsSync(path.join(home, ".opencode", "agents", "alter.md")));
});

test("an agent-home adapter still gets the full scaffold", async (t) => {
  const root = makeProject(t);
  const { adapter } = stubAdapter();
  withHarness(t, "homed", adapter);
  const { home } = await spawnAlter(root, options({ executor: "homed" }), {});
  assert.ok(existsSync(path.join(home, "AGENTS.md")));
  assert.ok(existsSync(path.join(home, ".opencode", "agents", "alter.md")));
});

test("scaffold's agentFiles flag is what draws the line", (t) => {
  const root = makeProject(t);
  const cfg = { catalog_dir: "catalog", max_depth: 5 };
  const bare = scaffold(root, cfg, createSpawnOptions({ id: "bare", name: "bare", depth: 0, spawned_by: "root", model: "m" }), undefined, { agentFiles: false });
  assert.ok(existsSync(path.join(bare, "alter.json")));
  assert.ok(!existsSync(path.join(bare, "AGENTS.md")));

  const full = scaffold(root, cfg, createSpawnOptions({ id: "full", name: "full", depth: 0, spawned_by: "root", model: "m" }));
  assert.ok(existsSync(path.join(full, "AGENTS.md")), "agentFiles defaults to true");
});

// --- how an executor is declared ------------------------------------------------

test("executor travels on a manifest and through spawn arguments", () => {
  const fromCatalog = createSpawnOptions({});
  applyCatalog(fromCatalog, { dir: "/tmp/x", manifest: { name: "compress", description: "d", executor: "llm" } });
  assert.equal(fromCatalog.executor, "llm");

  const explicit = createSpawnOptions({ executor: "function" });
  applyCatalog(explicit, { dir: "/tmp/x", manifest: { name: "compress", description: "d", executor: "llm" } });
  assert.equal(explicit.executor, "function", "an explicit spawn-time executor wins over the manifest");

  assert.equal(parseSpawnArgs(["--executor", "llm", "go"]).executor, "llm");
  assert.equal(parseSpawnArgs(["go"]).executor, null);
});

test("a manifest's executor is shape-checked, but its existence is settled at spawn time", () => {
  // Naming an adapter that is not registered yet has to stay valid: a manifest is
  // written, and copied into a child's kit, long before anything registers one.
  assert.equal(validateManifest({ name: "c", description: "d", executor: "llm" }, "c"), undefined);
  assert.throws(() => validateManifest({ name: "c", description: "d", executor: "" }, "c"), /executor must be the name/);
  assert.throws(() => validateManifest({ name: "c", description: "d", executor: 7 }, "c"), /executor must be the name/);
});
