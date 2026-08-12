// A real (non-mocked) integration test: spawns a nestable Alter and has it
// spawn a real grandchild via its own scoped shell, then asserts the
// grandchild's run folder exists with `result.json.ok === true`. This is the
// one path most exercised by the actual vision (alters spawning alters) and,
// This command-composition path once had no automated coverage.
//
// It hits a real model through a real `opencode` process, so it is opt-in and
// skipped by default: set MIND_LIVE_TESTS=1 to run it.
//   MIND_LIVE_TESTS=1 node --test packages/core/test/integration/nested-spawn.test.js
// Override the model with MIND_LIVE_TEST_MODEL if the default isn't available
// under your opencode auth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAlter } from "@mind/core";

const LIVE = process.env.MIND_LIVE_TESTS === "1";
const MODEL = process.env.MIND_LIVE_TEST_MODEL || "opencode/deepseek-v4-flash-free";
const CLI_ENTRY = fileURLToPath(new URL("../../../cli/src/index.js", import.meta.url));

test(
  "a nestable Alter can spawn a real child Alter",
  { skip: !LIVE && "hits a real model; set MIND_LIVE_TESTS=1 to run" },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "mind-live-"));
    mkdirSync(path.join(root, ".alters"), { recursive: true });
    writeFileSync(
      path.join(root, ".alters", "config.json"),
      JSON.stringify(
        {
          default_model: MODEL,
          max_depth: 5,
          run_timeout_ms: 60000,
          catalog_dir: "catalog",
          default_fallback_model: null,
          retry: { same_harness_retries: 0, fallback_retries: 0 },
        },
        null,
        2
      )
    );
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const { home, result } = await spawnAlter(root, {
      name: "nest-parent",
      description: "Spawns exactly one child Alter, then reports whether it succeeded.",
      nestable: true,
      mindBinPath: CLI_ENTRY,
      timeout: 60000,
      readGrants: [],
      writeGrants: [],
      bashAllow: [],
      prompt:
        "Follow the exact command shown in your own AGENTS.md, under " +
        '"Spawning child Alters", to spawn one child Alter with --name ' +
        '"grandchild" --description "says hello" and the prompt "reply with ' +
        'the single word: hello". Wait for it to finish, then reply with ' +
        'the single word DONE.',
    });

    const childRunsDir = path.join(home, ".alters", "runs");
    let childFolders = [];
    try {
      childFolders = readdirSync(childRunsDir);
    } catch {}

    if (childFolders.length === 0) {
      assert.fail(
        `parent never created a child run folder under ${childRunsDir}.\n` +
          `parent ok=${result.ok} exit_code=${result.exit_code}\n` +
          `parent result.md:\n${readFileSync(path.join(home, "result.md"), "utf8")}`
      );
    }

    const childHome = path.join(childRunsDir, childFolders[childFolders.length - 1]);
    const childAlterJson = JSON.parse(readFileSync(path.join(childHome, "alter.json"), "utf8"));
    const childResult = JSON.parse(readFileSync(path.join(childHome, "result.json"), "utf8"));

    assert.equal(childAlterJson.depth, 1, "child should be one level deeper than its parent");
    assert.equal(
      childResult.ok,
      true,
      `child did not complete ok. child result.md:\n${readFileSync(path.join(childHome, "result.md"), "utf8")}`
    );
  }
);
