// `initMind` is `mind init` with the terminal taken out of it, so what matters here is
// that moving it did not change the two rules that make identity durable: reinitializing
// preserves the `agent_id`, and only an explicit re-identification replaces it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, defaultProfileDir, initMind, isMindProject, readAgentIdentity } from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);
const runtime = createRuntime({ now: () => FROZEN, env: {} });

const sandbox = () => mkdtempSync(path.join(tmpdir(), "mind-init-"));

// A minimal profile, so these tests assert `initMind`'s behaviour rather than the shipped
// profile's contents.
const profile = (base) => {
  const dir = path.join(base, "profile");
  mkdirSync(path.join(dir, "catalog", "curator"), { recursive: true });
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "test-profile" }));
  writeFileSync(path.join(dir, "AGENTS.md"), "# instructions\n");
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ default_model: "test/model" }));
  writeFileSync(path.join(dir, "catalog", "curator", "manifest.json"), JSON.stringify({ name: "curator" }));
  return dir;
};

const readConfigFile = (root) => JSON.parse(readFileSync(path.join(root, ".alters", "config.json"), "utf8"));

test("initMind scaffolds a mind at an explicit directory and reports it", () => {
  const base = sandbox();
  const root = path.join(base, "minds", "scribe");

  const report = initMind(root, { name: "scribe", profileDir: profile(base), runtime });

  assert.equal(report.root, root);
  assert.equal(report.name, "scribe");
  assert.equal(report.profile, "test-profile");
  assert.equal(report.reinitialized, false);
  assert.match(report.agentId, /^[0-9a-f]{32}$/);
  assert.equal(isMindProject(root), true);

  const config = readConfigFile(root);
  assert.equal(config.agent_id, report.agentId);
  // Profile overrides land over the engine defaults.
  assert.equal(config.default_model, "test/model");
  // Defaults survive the merge.
  assert.equal(config.max_depth, 12);
  // The catalog, the instructions and the ignore rules come with it.
  assert.ok(readFileSync(path.join(root, ".alters", "catalog", "curator", "manifest.json"), "utf8"));
  assert.ok(readFileSync(path.join(root, "AGENTS.md"), "utf8"));
  assert.match(readFileSync(path.join(root, ".gitignore"), "utf8"), /\.alters\/memory\//);

  rmSync(base, { recursive: true, force: true });
});

test("initMind refuses to touch an existing mind unless forced, and never re-identifies it", () => {
  const base = sandbox();
  const root = path.join(base, "scribe");
  const profileDir = profile(base);
  const first = initMind(root, { name: "scribe", profileDir, runtime });

  assert.throws(() => initMind(root, { profileDir, runtime }), /already a mind project/);

  const again = initMind(root, { profileDir, force: true, runtime });
  // The whole point of Phase 1: refreshing a mind's files must not orphan its memory.
  assert.equal(again.agentId, first.agentId);
  assert.equal(again.identityPreserved, true);
  assert.equal(again.reinitialized, true);
  assert.equal(again.previousAgentId, null);
  assert.equal(again.name, "scribe");

  rmSync(base, { recursive: true, force: true });
});

test("a new identity is explicit, reported, and drops the legacy memory pin with it", () => {
  const base = sandbox();
  const root = path.join(base, "fork");
  const profileDir = profile(base);
  const original = initMind(root, { name: "fork", profileDir, runtime });
  // A mind whose store predates agent_id carries the pin; a fork must not keep writing
  // into the original's namespace.
  const pinned = { ...readConfigFile(root), memory_project_id: "legacy-project" };
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify(pinned));

  const reforked = initMind(root, { profileDir, force: true, newIdentity: true, runtime });

  assert.notEqual(reforked.agentId, original.agentId);
  assert.equal(reforked.previousAgentId, original.agentId);
  // Back to the default, which is what "not pinned" looks like in a config.
  assert.equal(readConfigFile(root).memory_project_id, null);
  assert.equal(readAgentIdentity(root).agentId, reforked.agentId);

  rmSync(base, { recursive: true, force: true });
});

test("a mind's name defaults to its directory and never re-derives on reinit", () => {
  const base = sandbox();
  const root = path.join(base, "chronicler");
  const profileDir = profile(base);

  assert.equal(initMind(root, { profileDir, runtime }).name, "chronicler");
  // A rename is a config edit; reinitializing must not undo it.
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ ...readConfigFile(root), name: "renamed" }),
  );
  assert.equal(initMind(root, { profileDir, force: true, runtime }).name, "renamed");
  // An explicit name still wins.
  assert.equal(initMind(root, { profileDir, force: true, name: "explicit", runtime }).name, "explicit");

  rmSync(base, { recursive: true, force: true });
});

test("a host that has no version to declare does not write an unresolvable dependency", () => {
  const base = sandbox();
  const profileDir = profile(base);

  const hosted = path.join(base, "hosted");
  initMind(hosted, { profileDir, runtime });
  assert.equal(JSON.parse(readFileSync(path.join(hosted, "package.json"), "utf8")).dependencies.mind, undefined);

  const fromCli = path.join(base, "from-cli");
  initMind(fromCli, { profileDir, cliVersion: "0.1.0", runtime });
  assert.equal(JSON.parse(readFileSync(path.join(fromCli, "package.json"), "utf8")).dependencies.mind, "^0.1.0");

  rmSync(base, { recursive: true, force: true });
});

test("the shipped profile is findable from core, in both the repo and the packaged layout", () => {
  // core holds `initMind` but the profile files ship with the CLI, so this probe is what
  // makes a host able to create a mind without spawning one.
  assert.ok(readFileSync(path.join(defaultProfileDir(), "profile.json"), "utf8"));
});
