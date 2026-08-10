// An oscillation owns no work: it decides when spikes fire and in what order. So the
// tests inject `runSpike` and assert on ordering, coupling and skipping — the scheduling
// is deterministic and worth pinning down exactly, and none of it should require a model.
//
// Phase 0's refractory lock is the guard underneath all of this; the cases here are the
// ones that only appear once a scheduler is the thing firing spikes.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntime,
  formatDuration,
  oscillationDueness,
  parseDuration,
  readCycleLog,
  readOscillations,
  readSkipLog,
  oscillationStatePath,
  runOscillation,
  validateOscillation,
} from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);

const clock = (startMs = FROZEN) => {
  let ms = startMs;
  return {
    advance: (delta) => (ms += delta),
    runtime: () => createRuntime({ now: () => ms, env: {}, pid: 4242 }),
  };
};

const projectRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-oscillation-"));
  mkdirSync(path.join(root, ".alters", "oscillations"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({ catalog_dir: "catalog" }));
  return root;
};

const writeOscillation = (root, name, body) =>
  writeFileSync(path.join(root, ".alters", "oscillations", `${name}.json`), JSON.stringify(body));

const oscillation = (overrides = {}) =>
  validateOscillation({
    id: "metabolic",
    band: "slow",
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
    ...overrides,
  });

// Records the order spikes actually ran in, and when, so parallel-within-phase is
// distinguishable from merely sequential.
const recorder = (behaviour = {}) => {
  const started = [];
  const order = [];
  let gate = null;
  return {
    started,
    order,
    openGate: () => gate?.(),
    runSpike: async ({ spike }) => {
      started.push(spike.id);
      if (behaviour[spike.id]?.blockUntilGate) {
        await new Promise((resolve) => (gate = resolve));
      }
      order.push(spike.id);
      if (behaviour[spike.id]?.throws) throw new Error(behaviour[spike.id].throws);
      return behaviour[spike.id]?.result ?? { ok: true };
    },
  };
};

test("durations parse and round-trip", () => {
  assert.equal(parseDuration("6h"), 21_600_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration(1500), 1500);
  assert.equal(formatDuration(21_600_000), "6h");
  assert.equal(formatDuration(90_000), "90s");
  assert.throws(() => parseDuration("6 fortnights", "period"), /period is not a duration/);
});

test("a band supplies the default period, and refractory defaults to the period", () => {
  const slow = oscillation();
  assert.equal(slow.periodMs, parseDuration("6h"));
  assert.equal(slow.refractoryMs, slow.periodMs);

  const explicit = oscillation({ period: "1h", refractory: "15m" });
  assert.equal(explicit.periodMs, parseDuration("1h"));
  assert.equal(explicit.refractoryMs, parseDuration("15m"));
  assert.throws(() => oscillation({ band: "theta" }), /unknown band/);
});

test("a spike needs exactly one kind, and gates may only look backwards", () => {
  assert.throws(() => oscillation({ spikes: [{ id: "x" }] }), /exactly one of graph \/ catalog/);
  assert.throws(
    () => oscillation({ spikes: [{ id: "x", graph: "g", catalog: "c" }] }),
    /exactly one of graph \/ catalog/,
  );
  assert.throws(() => oscillation({ spikes: [{ id: "x", graph: "g" }, { id: "x", graph: "g" }] }), /duplicate spike id/);
  assert.throws(
    () => oscillation({ spikes: [{ id: "a", graph: "g" }, { id: "b", graph: "g", after: "nope" }] }),
    /afters unknown spike nope/,
  );
  // Same phase means parallel, so reading a sibling's result would make the outcome
  // depend on which of the two happened to finish first.
  assert.throws(
    () => oscillation({ spikes: [{ id: "a", graph: "g" }, { id: "b", graph: "g", when: "a.freed" }] }),
    /which is in phase 0 — it must be in an earlier phase/,
  );
});

test("same phase runs in parallel; a later phase waits for it", async () => {
  const root = projectRoot();
  const c = clock();
  const spy = recorder({ scan: { blockUntilGate: true } });
  const spec = oscillation({
    spikes: [
      { id: "scan", phase: 0, graph: "memory-maintenance" },
      { id: "reward", phase: 0, catalog: "reward-scorer" },
      { id: "compact", phase: 1, catalog: "compactor" },
    ],
  });

  const running = runOscillation(root, spec, { runtime: c.runtime(), runSpike: spy.runSpike });
  await new Promise((resolve) => setImmediate(resolve));
  // `reward` is in flight while `scan` is blocked — they are genuinely concurrent — and
  // `compact` has not been reached at all.
  assert.deepEqual(spy.started, ["scan", "reward"]);
  assert.deepEqual(spy.order, ["reward"]);

  spy.openGate();
  const outcome = await running;
  assert.deepEqual(spy.started, ["scan", "reward", "compact"]);
  assert.deepEqual(outcome.cycle.spikes.map((s) => [s.id, s.state]), [
    ["scan", "ok"],
    ["reward", "ok"],
    ["compact", "ok"],
  ]);
});

test("a failing spike does not cancel its siblings, and the cycle still completes", async () => {
  const root = projectRoot();
  const c = clock();
  const spy = recorder({ scan: { throws: "planner refused" } });
  const spec = oscillation({
    spikes: [
      { id: "scan", phase: 0, graph: "memory-maintenance" },
      { id: "reward", phase: 0, catalog: "reward-scorer" },
      { id: "later", phase: 1, catalog: "compactor" },
    ],
  });

  const outcome = await runOscillation(root, spec, { runtime: c.runtime(), runSpike: spy.runSpike });
  assert.equal(outcome.ran, true);
  const states = Object.fromEntries(outcome.cycle.spikes.map((s) => [s.id, s.state]));
  assert.deepEqual(states, { scan: "error", reward: "ok", later: "ok" });
  assert.match(outcome.cycle.spikes.find((s) => s.id === "scan").error, /planner refused/);
});

test("`after` gates on success and `when` gates on a value", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({
    spikes: [
      { id: "scan", phase: 0, graph: "memory-maintenance" },
      { id: "compact", phase: 1, after: "scan", when: "scan.freedSpace", catalog: "compactor" },
    ],
  });

  // Ran, succeeded, freed nothing — the value gate closes.
  const quiet = recorder({ scan: { result: { freedSpace: false } } });
  let outcome = await runOscillation(root, spec, { runtime: c.runtime(), runSpike: quiet.runSpike });
  assert.deepEqual(quiet.started, ["scan"]);
  assert.equal(outcome.cycle.spikes.find((s) => s.id === "compact").skipped, "when:scan.freedSpace");

  // Freed something — it fires.
  c.advance(parseDuration("6h"));
  const busy = recorder({ scan: { result: { freedSpace: true } } });
  outcome = await runOscillation(root, spec, { runtime: c.runtime(), runSpike: busy.runSpike });
  assert.deepEqual(busy.started, ["scan", "compact"]);
  assert.equal(outcome.cycle.spikes.find((s) => s.id === "compact").state, "ok");

  // Failed outright — `after` closes before `when` is ever consulted.
  c.advance(parseDuration("6h"));
  const broken = recorder({ scan: { throws: "boom" } });
  outcome = await runOscillation(root, spec, { runtime: c.runtime(), runSpike: broken.runSpike });
  assert.deepEqual(broken.started, ["scan"]);
  assert.equal(outcome.cycle.spikes.find((s) => s.id === "compact").skipped, "after:scan");
});

test("a nested `when` path reads into the result", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({
    spikes: [
      { id: "scan", phase: 0, graph: "memory-maintenance" },
      { id: "compact", phase: 1, when: "scan.storage.reclaimedBytes", catalog: "compactor" },
    ],
  });
  const spy = recorder({ scan: { result: { storage: { reclaimedBytes: 4096 } } } });
  await runOscillation(root, spec, { runtime: c.runtime(), runSpike: spy.runSpike });
  assert.deepEqual(spy.started, ["scan", "compact"]);
});

test("a rhythm inside its refractory period is skipped, and the skip is recorded", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({ period: "6h" });
  const spy = recorder();

  assert.equal((await runOscillation(root, spec, { runtime: c.runtime(), runSpike: spy.runSpike })).ran, true);
  c.advance(parseDuration("1h"));
  const skipped = await runOscillation(root, spec, { runtime: c.runtime(), runSpike: spy.runSpike });
  assert.deepEqual(skipped, { ran: false, skipped: "refractory", cycle: null });
  assert.deepEqual(spy.started, ["scan"], "the spike did not run a second time");

  const skips = readSkipLog(oscillationStatePath(root, "metabolic"));
  assert.equal(skips.length, 1);
  assert.equal(skips[0].requested_by, "schedule");
});

test("force waives the refractory window but never a running cycle", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({ period: "6h" });

  await runOscillation(root, spec, { runtime: c.runtime(), runSpike: recorder().runSpike });
  c.advance(parseDuration("1m"));
  const forced = await runOscillation(root, spec, { runtime: c.runtime(), force: true, runSpike: recorder().runSpike });
  assert.equal(forced.ran, true);
  assert.equal(forced.cycle.forced, true);

  // Re-entered from inside its own cycle: `force` cannot help, because the lock is not a
  // policy — it is the fact that a cycle is still running.
  let inner = null;
  const reentrant = recorder();
  await runOscillation(root, spec, {
    runtime: c.runtime(),
    force: true,
    runSpike: async (args) => {
      inner = await runOscillation(root, spec, { runtime: c.runtime(), force: true, runSpike: reentrant.runSpike });
      return { ok: true };
    },
  });
  assert.deepEqual(inner, { ran: false, skipped: "busy", cycle: null });
  assert.deepEqual(reentrant.started, []);
});

test("due-ness is the schedule, and is separate from the refractory floor", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({ period: "1h", refractory: "15m" });

  let dueness = oscillationDueness(root, spec, FROZEN);
  assert.deepEqual(dueness, { due: true, lastRunAt: null, elapsedMs: null, dueInMs: 0 });

  await runOscillation(root, spec, { runtime: c.runtime(), runSpike: recorder().runSpike });
  dueness = oscillationDueness(root, spec, FROZEN);
  assert.equal(dueness.due, false);
  assert.equal(dueness.dueInMs, parseDuration("1h"));

  // Half an hour on: the schedule says not yet, but the refractory floor has passed — so
  // something that triggers this rhythm off-schedule would be allowed to.
  const half = FROZEN + parseDuration("30m");
  assert.equal(oscillationDueness(root, spec, half).due, false);
  c.advance(parseDuration("30m"));
  assert.equal((await runOscillation(root, spec, { runtime: c.runtime(), runSpike: recorder().runSpike })).ran, true);
});

test("every cycle appends an audit line", async () => {
  const root = projectRoot();
  const c = clock();
  const spec = oscillation({ period: "1h" });

  await runOscillation(root, spec, { runtime: c.runtime(), runSpike: recorder().runSpike });
  c.advance(parseDuration("1h"));
  await runOscillation(root, spec, { runtime: c.runtime(), runSpike: recorder({ scan: { throws: "no" } }).runSpike });

  const cycles = readCycleLog(root, "metabolic");
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles.map((cycle) => cycle.spikes[0].state), ["ok", "error"]);
  assert.equal(cycles[0].started_at, "2026-08-06T12:00:00.000Z");
  assert.equal(cycles[1].started_at, "2026-08-06T13:00:00.000Z");
});

test("oscillations are read from disk, and the filename is the fallback id", () => {
  const root = projectRoot();
  writeOscillation(root, "metabolic", { band: "slow", spikes: [{ id: "scan", graph: "memory-maintenance" }] });
  writeOscillation(root, "curation", { id: "curation", band: "fast", enabled: false, spikes: [{ id: "curate", catalog: "curator" }] });

  const found = readOscillations(root);
  assert.deepEqual(found.map((o) => o.id), ["curation", "metabolic"]);
  assert.equal(found.find((o) => o.id === "metabolic").periodMs, parseDuration("6h"));
  assert.equal(found.find((o) => o.id === "curation").enabled, false);
});

test("a malformed oscillation file names itself in the error", () => {
  const root = projectRoot();
  writeFileSync(path.join(root, ".alters", "oscillations", "broken.json"), "{ not json");
  assert.throws(() => readOscillations(root), /oscillations\/broken\.json is not valid JSON/);
});
