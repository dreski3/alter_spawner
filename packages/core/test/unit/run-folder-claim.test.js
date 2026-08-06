// Two spikes released on the same tick used to compute a byte-identical run folder and
// both proceed, because `existsSync` followed by `mkdirSync(..., { recursive: true })`
// is a check-then-act where the act does not fail on collision. The second run then
// overwrote the first's alter.json and later its result.json.
//
// The clock is frozen inside one UTC second in every test here. That does not manufacture
// the bug — timestamp slugs are second-resolution and a graph node's run name is its node
// id, so a scheduler firing N nodes on one tick is that same second. Freezing it only
// removes the timing luck that makes the race intermittent.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, runAlterGraph, scaffold } from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);

const projectRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-claim-"));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ catalog_dir: "catalog" }));
  return root;
};

// randomId is deterministic per runtime so the assertions can name the exact suffix
// rather than matching a pattern — the point being that the retry produced a *different*
// folder, not merely a folder.
const testRuntime = (letter) =>
  createRuntime({
    now: () => FROZEN,
    randomId: (length = 12) => letter.repeat(length),
    env: {},
  });

const runsIn = (root) => readdirSync(path.join(root, ".alters", "runs")).sort();

test("concurrent spawns on one tick each get their own run folder", () => {
  const root = projectRoot();
  const cfg = { catalog_dir: "catalog" };
  const options = (description) => ({ id: "summarize", description, prompt: "x", model: "m" });

  const alpha = { ...options("ALPHA") };
  const beta = { ...options("BETA") };
  const gamma = { ...options("GAMMA") };

  const homeA = scaffold(root, cfg, alpha, testRuntime("a"), { agentFiles: false });
  const homeB = scaffold(root, cfg, beta, testRuntime("b"), { agentFiles: false });
  const homeC = scaffold(root, cfg, gamma, testRuntime("c"), { agentFiles: false });

  assert.notEqual(homeA, homeB);
  assert.notEqual(homeB, homeC);
  assert.notEqual(homeA, homeC);
  assert.deepEqual(runsIn(root), [
    "20260806T120000Z_summarize",
    "20260806T120000Z_summarize-bbbb",
    "20260806T120000Z_summarize-cccc",
  ]);
});

test("a run folder that is already claimed does not have its records overwritten", () => {
  const root = projectRoot();
  const cfg = { catalog_dir: "catalog" };

  const first = { id: "summarize", description: "ALPHA", prompt: "x", model: "m" };
  const second = { id: "summarize", description: "BETA", prompt: "x", model: "m" };
  scaffold(root, cfg, first, testRuntime("a"), { agentFiles: false });
  scaffold(root, cfg, second, testRuntime("b"), { agentFiles: false });

  assert.equal(first.runFolder, "20260806T120000Z_summarize");
  assert.equal(second.runFolder, "20260806T120000Z_summarize-bbbb");
});

test("the fifth colliding claim fails rather than silently sharing a folder", () => {
  const root = projectRoot();
  const cfg = { catalog_dir: "catalog" };
  // Every attempt draws the same suffix, so with both names already taken all five
  // attempts collide and the loop must run out rather than reuse either folder.
  const stubborn = createRuntime({ now: () => FROZEN, randomId: () => "zzzz", env: {} });
  mkdirSync(path.join(root, ".alters", "runs", "20260806T120000Z_summarize"), { recursive: true });
  mkdirSync(path.join(root, ".alters", "runs", "20260806T120000Z_summarize-zzzz"), { recursive: true });

  assert.throws(
    () => scaffold(root, cfg, { id: "summarize", prompt: "x", model: "m" }, stubborn, { agentFiles: false }),
    /could not allocate a unique run folder/,
  );
  assert.deepEqual(runsIn(root), ["20260806T120000Z_summarize", "20260806T120000Z_summarize-zzzz"]);
});

test("graph homes started on one tick do not share a directory", async () => {
  const root = projectRoot();
  const graph = {
    id: "maintenance",
    nodes: [{ id: "only", prompt: "x", executor: { type: "function" } }],
    output: "only",
  };

  // The nodes are irrelevant here — only the home allocation is under test, so each run
  // is allowed to fail once its directory has been claimed.
  for (const letter of ["a", "b", "c"]) {
    await runAlterGraph(root, graph, { runtime: testRuntime(letter) }).catch(() => {});
  }

  const graphDirs = readdirSync(path.join(root, ".alters", "graphs")).sort();
  assert.equal(graphDirs.length, 3, `expected three graph homes, got ${JSON.stringify(graphDirs)}`);
});
