// `mind run <home>` is inside a nestable Alter's allowed command form, and resolveHome
// accepts an absolute path. A child's own home sits at
// `<parent-home>/.alters/runs/<child-id>`, so a child can name its parent's home as
// `../../..` — and nothing about the depth ceiling stops it, because runExistingAlter
// takes depth from the target's alter.json rather than from ALTER_DEPTH.
//
// That is not a nesting-depth problem, it is a containment problem: re-running an
// ancestor writes result.json into a home that is still in flight, and regenerates the
// alter.md that the ancestor's live session is reading. The budget eventually stops the
// recursion, but by then the ancestor's own record has been overwritten.
//
// The rule under test: an Alter may re-run its own descendants and nothing else. A host,
// which has no ALTER_DEPTH, keeps unrestricted access — the CLI and the bridge both
// legitimately address homes by absolute path.
//
// Stub executor, so no model and no opencode process.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createRuntime,
  createSpawnOptions,
  registerHarness,
  runExistingAlter,
  spawnAlter,
} from "@mind/core";

// needsAgentHome: a nestable Alter has to have a sandbox, so an adapter that reads
// nothing off disk is refused the combination.
registerHarness("reentry-stub", {
  needsAgentHome: true,
  run: async (home, prompt) => ({
    tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
    text: `ran:${prompt}`,
    sessionID: null,
    steps: 1,
    exitCode: 0,
    killed: false,
    ok: true,
    budget_exceeded: false,
    empty_output: false,
  }),
});

const writeConfig = (root) => {
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({
      default_model: "test/model",
      max_depth: 6,
      retry: { same_harness_retries: 0, fallback_retries: 0 },
    }),
  );
  return root;
};

const project = (t, prefix = "mind-reentry-") => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return writeConfig(root);
};

const asAlter = (depth, id = "descendant") =>
  createRuntime({ env: { ...process.env, ALTER_DEPTH: String(depth), ALTER_ID: id } });

// Spawns a nestable Alter, so the returned home is itself a project root with its own
// `.alters/runs` for children.
const spawnNestable = (root, name, runtime) => spawnAlter(root, createSpawnOptions({
  name,
  prompt: "work",
  executor: "reentry-stub",
  nestable: true,
}), runtime ? { runtime } : {});

const resultText = (home) => JSON.parse(readFileSync(path.join(home, "result.json"), "utf8")).text;

test("a descendant cannot re-run an ancestor's home", async (t) => {
  const root = project(t);
  // Depth 0, spawned by the host.
  const { home: ancestor } = await spawnNestable(root, "ancestor");
  // Depth 1, spawned by the ancestor: its project root is the ancestor's home.
  const { home: child } = await spawnNestable(ancestor, "child", asAlter(0, "ancestor"));

  const before = resultText(ancestor);
  assert.equal(before, "ran:work");
  // The path a child can always derive: its own home is <ancestor>/.alters/runs/<id>.
  assert.equal(path.resolve(child, "..", "..", ".."), path.resolve(ancestor));

  await assert.rejects(
    // The child's own root is its home, and it names its ancestor by absolute path.
    () => runExistingAlter(child, ancestor, "re-enter my parent", { runtime: asAlter(1, "child") }),
    /outside|descendant|own runs/i,
    "a child was allowed to re-run its ancestor's home",
  );

  // The point of the guard: the ancestor's record is intact. Before it, this re-run
  // succeeded and overwrote result.json in a home whose own run was still in flight.
  assert.equal(resultText(ancestor), before, "the ancestor's result.json was overwritten");
});

test("a node may still re-run a home it owns", async (t) => {
  const root = project(t);
  const { home: parent } = await spawnNestable(root, "parent");
  const { home: child } = await spawnNestable(parent, "child", asAlter(0, "parent"));

  // Re-running its own child is the legitimate case and stays allowed: the home is
  // inside the caller's own runs directory.
  const { result } = await runExistingAlter(parent, child, "again", { runtime: asAlter(0, "parent") });
  assert.equal(result.ok, true);
  assert.equal(result.text, "ran:again");
  assert.equal(resultText(child), "ran:again");
});

test("a node cannot re-run its own home", async (t) => {
  const root = project(t);
  const { home: self } = await spawnNestable(root, "selfref");
  // Self-re-entry is the same clobber with one fewer step, and a home is not inside its
  // own runs directory, so the containment rule covers it without a special case.
  await assert.rejects(
    () => runExistingAlter(self, self, "re-enter myself", { runtime: asAlter(0, "selfref") }),
    /outside|descendant|own runs/i,
  );
});

test("a node cannot re-run a home belonging to another project", async (t) => {
  const root = project(t);
  const other = project(t, "mind-reentry-other-");
  const { home: mine } = await spawnNestable(root, "mine");
  const { home: theirs } = await spawnNestable(other, "theirs");

  await assert.rejects(
    () => runExistingAlter(mine, theirs, "reach across projects", { runtime: asAlter(0, "mine") }),
    /outside|descendant|own runs/i,
  );
  assert.equal(resultText(theirs), "ran:work");
});

test("a host keeps unrestricted access to any home by absolute path", async (t) => {
  const root = project(t);
  const other = project(t, "mind-reentry-host-");
  const { home: elsewhere } = await spawnNestable(other, "elsewhere");

  // No ALTER_DEPTH: the caller is the CLI or the bridge, not an Alter. Both address
  // homes by absolute path deliberately, so the restriction must not apply to them.
  const { result } = await runExistingAlter(root, elsewhere, "host re-run", {
    runtime: createRuntime({ env: { ...process.env } }),
  });
  assert.equal(result.ok, true);
  assert.equal(resultText(elsewhere), "ran:host re-run");
});
