// Definitions were read-only: a rhythm existed because somebody typed a JSON file. That
// is right for a repo-committed definition and useless for a host, which is the caller
// that needs to create a rhythm in order to demonstrate one.
//
// What is asserted here is that authoring goes through the same validator the daemon
// trusts, that a rejected definition leaves nothing behind, and that a written file is
// still the shape a human would have typed.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteOscillation,
  oscillationStatePath,
  oscillationsDir,
  readCycleLog,
  readOscillation,
  readOscillations,
  writeOscillation,
} from "../../src/index.js";

const projectRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-osc-write-"));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ catalog_dir: "catalog" }));
  return root;
};

const METABOLIC = {
  id: "metabolic",
  band: "slow",
  spikes: [
    { id: "scan", phase: 0, graph: "memory-maintenance" },
    { id: "compact", phase: 1, after: "scan", when: "scan.freedSpace", graph: "memory-maintenance", options: { compact: true } },
  ],
};

test("writing a rhythm creates the oscillations directory and a readable definition", () => {
  const root = projectRoot();
  const written = writeOscillation(root, METABOLIC);

  assert.equal(written.created, true);
  assert.equal(written.file, path.join(oscillationsDir(root), "metabolic.json"));
  // The band's default period is resolved on the way in, so the file states a period
  // rather than depending on the band table never changing.
  assert.equal(written.periodMs, 21_600_000);

  const [read] = readOscillations(root);
  assert.equal(read.id, "metabolic");
  assert.equal(read.periodMs, 21_600_000);
  assert.equal(read.refractoryMs, 21_600_000);
  assert.equal(read.spikes.length, 2);

  rmSync(root, { recursive: true, force: true });
});

test("a written definition is the shape a human would have typed", () => {
  const root = projectRoot();
  writeOscillation(root, METABOLIC);

  const raw = JSON.parse(readFileSync(path.join(oscillationsDir(root), "metabolic.json"), "utf8"));
  assert.equal(raw.period, "6h");
  assert.equal(raw.refractory, "6h");
  assert.equal(raw.periodMs, undefined);
  // Fields a spike did not set are absent, not a wall of nulls.
  assert.deepEqual(raw.spikes[0], { id: "scan", phase: 0, graph: "memory-maintenance" });
  assert.equal(raw.spikes[1].after, "scan");
  assert.equal(raw.spikes[1].when, "scan.freedSpace");
  assert.deepEqual(raw.spikes[1].options, { compact: true });

  rmSync(root, { recursive: true, force: true });
});

test("an invalid definition is rejected before anything is written", () => {
  const root = projectRoot();

  // Same validator the daemon trusts: `when` may only look backwards.
  assert.throws(
    () => writeOscillation(root, { id: "bad", spikes: [{ id: "a", phase: 0, catalog: "x", when: "b.ok" }, { id: "b", phase: 0, catalog: "y" }] }),
    /must be in an earlier phase/,
  );
  assert.throws(() => writeOscillation(root, { id: "empty", spikes: [] }), /at least one spike/);
  assert.throws(() => writeOscillation(root, { id: "nokind", spikes: [{ id: "a" }] }), /exactly one of/);

  // A half-written rhythm is one the daemon would fail on every tick, so nothing lands.
  assert.equal(existsSync(oscillationsDir(root)) ? readdirSync(oscillationsDir(root)).length : 0, 0);

  rmSync(root, { recursive: true, force: true });
});

test("rewriting an id rewrites its file rather than adding a second definition for it", () => {
  const root = projectRoot();
  // An id may live in a file named something else — readOscillations only falls back to
  // the filename.
  mkdirSync(oscillationsDir(root), { recursive: true });
  writeFileSync(
    path.join(oscillationsDir(root), "nightly.json"),
    JSON.stringify({ id: "metabolic", period: "1h", spikes: [{ id: "scan", catalog: "curator" }] }),
  );

  const rewritten = writeOscillation(root, { ...METABOLIC, period: "2h" });

  assert.equal(rewritten.created, false);
  assert.equal(path.basename(rewritten.file), "nightly.json");
  assert.equal(readdirSync(oscillationsDir(root)).length, 1);
  assert.equal(readOscillation(root, "metabolic").periodMs, 7_200_000);

  rmSync(root, { recursive: true, force: true });
});

test("overwrite:false refuses to replace an existing rhythm", () => {
  const root = projectRoot();
  writeOscillation(root, METABOLIC);

  assert.throws(() => writeOscillation(root, METABOLIC, { overwrite: false }), /already exists/);
  assert.equal(readOscillation(root, "metabolic").periodMs, 21_600_000);

  rmSync(root, { recursive: true, force: true });
});

test("deleting a rhythm keeps its audit unless the caller asks for a clean slate", () => {
  const root = projectRoot();
  writeOscillation(root, METABOLIC);
  // Stand in for a cycle the daemon already ran.
  const stateDir = path.dirname(oscillationStatePath(root, "metabolic"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(oscillationStatePath(root, "metabolic"), JSON.stringify({ last_run_at: "2026-08-06T00:00:00.000Z" }));
  writeFileSync(path.join(stateDir, "metabolic.cycles.jsonl"), JSON.stringify({ oscillation: "metabolic", spikes: [] }) + "\n");

  const removed = deleteOscillation(root, "metabolic");
  assert.equal(existsSync(removed.file), false);
  assert.deepEqual(removed.purged, []);
  // Deleting a definition is not a claim that its cycles never happened.
  assert.equal(readCycleLog(root, "metabolic").length, 1);
  assert.equal(existsSync(oscillationStatePath(root, "metabolic")), true);

  // Re-created and deleted again, this time asking for the slate to be clean — otherwise
  // the new rhythm inherits its predecessor's last_run_at and sits there looking not-due.
  writeOscillation(root, METABOLIC);
  const purged = deleteOscillation(root, "metabolic", { purgeState: true });
  assert.equal(purged.purged.length, 2);
  assert.equal(existsSync(oscillationStatePath(root, "metabolic")), false);
  assert.equal(readCycleLog(root, "metabolic").length, 0);

  rmSync(root, { recursive: true, force: true });
});

test("deleting a rhythm that does not exist says so", () => {
  const root = projectRoot();
  assert.throws(() => deleteOscillation(root, "ghost"), /no oscillation named ghost/);
  rmSync(root, { recursive: true, force: true });
});
