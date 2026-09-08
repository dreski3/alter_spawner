import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFrontmatter,
  createRuntime,
  createSpawnOptions,
  registerHarness,
  spawnAlter,
} from "@mind/core";

const response = () => ({
  tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
  text: "ok",
  sessionID: null,
  steps: 1,
  exitCode: 0,
  killed: false,
  ok: true,
  budget_exceeded: false,
  empty_output: false,
});

const calls = [];
registerHarness("authority-boundary", {
  async run(_home, _prompt, options) {
    calls.push(options);
    return response();
  },
});
registerHarness("authority-other", { async run() { return response(); } });

const project = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "test/model",
    max_depth: 4,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  return root;
};

const options = (overrides = {}) => createSpawnOptions({
  name: "worker",
  prompt: "work",
  mindBinPath: "/opt/mind.js",
  ...overrides,
});

const asRunningAlter = (environment, id) => createRuntime({
  env: { ...environment, ALTER_DEPTH: "0", ALTER_ID: id },
});

test("a descendant cannot widen its immediate parent's authority", async (t) => {
  calls.length = 0;
  const root = project(t);
  const outside = path.join(root, "outside");
  const read = path.join(root, "read");
  const write = path.join(root, "write");
  const parent = await spawnAlter(root, options({
    name: "parent",
    nestable: true,
    model: "test/model",
    readGrants: [read],
    writeGrants: [write],
    bashAllow: ["node /opt/approved.mjs **"],
    webAccess: true,
  }), { harness: "authority-boundary" });
  const parentRuntime = asRunningAlter(calls.at(-1).environment, "parent");

  for (const [label, child, pattern] of [
    ["write", options({ writeGrants: [outside] }), /child authority exceeds parent write grants/],
    ["read", options({ readGrants: [outside] }), /child authority exceeds parent read grants/],
    ["bash", options({ bashAllow: ["node /opt/other.mjs **"] }), /child authority exceeds parent bash permissions/],
    ["model", options({ model: "other/model" }), /child authority exceeds parent models/],
    ["executor", options(), /child authority exceeds parent executors/],
    ["capability", options({ capability: { id: "world.move" } }), /child authority exceeds parent capabilities/],
  ]) {
    await assert.rejects(
      () => spawnAlter(parent.home, child, {
        createOnly: true,
        harness: label === "executor" ? "authority-other" : "authority-boundary",
        runtime: parentRuntime,
      }),
      pattern,
      label,
    );
  }
});

test("a narrowed child becomes the ceiling for its own descendants", async (t) => {
  calls.length = 0;
  const root = project(t);
  const write = path.join(root, "write");
  const childWrite = path.join(write, "child");
  const parent = await spawnAlter(root, options({
    name: "parent",
    nestable: true,
    writeGrants: [write],
    bashAllow: ["node /opt/approved.mjs **"],
    webAccess: true,
  }), { harness: "authority-boundary" });
  const child = await spawnAlter(parent.home, options({
    name: "child",
    nestable: true,
    writeGrants: [childWrite],
    bashAllow: ["node /opt/approved.mjs **"],
    webAccess: true,
  }), {
    harness: "authority-boundary",
    runtime: asRunningAlter(calls.at(-1).environment, "parent"),
  });
  const childRuntime = asRunningAlter(calls.at(-1).environment, "child");

  await assert.rejects(
    () => spawnAlter(child.home, options({ writeGrants: [write] }), {
      createOnly: true,
      harness: "authority-boundary",
      runtime: childRuntime,
    }),
    /child authority exceeds parent write grants/,
  );
});

test("nestable frontmatter exposes only delegation subcommands", () => {
  const frontmatter = buildFrontmatter(options({ nestable: true }));
  assert.match(frontmatter, /node \/opt\/mind\.js spawn \*\*/);
  assert.match(frontmatter, /node \/opt\/mind\.js create \*\*/);
  assert.match(frontmatter, /node \/opt\/mind\.js run \*\*/);
  assert.match(frontmatter, /node \/opt\/mind\.js catalog save \*\*/);
  assert.doesNotMatch(frontmatter, /node \/opt\/mind\.js \*\*/);
  assert.doesNotMatch(frontmatter, /node \/opt\/mind\.js rm/);
});
