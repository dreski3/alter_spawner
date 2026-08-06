// A rhythm re-entered while its previous cycle is still running plans against the same
// snapshot twice; the second pass's version checks then start failing mid-cycle, after
// the planner's tokens are already spent. So the guard is two questions, not one: is the
// previous cycle still running (the lock), and did it finish too recently (the state).
//
// A blocked tick is skipped, never queued — a backlog of maintenance passes is worse
// than a missed one — and every skip is logged, so a rhythm that permanently overruns its
// period is visible rather than silent.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, readRefractoryState, readSkipLog, withRefractoryPeriod } from "../../src/index.js";

const stateFile = () => path.join(mkdtempSync(path.join(tmpdir(), "mind-refractory-")), "metabolic.json");

// A mutable clock, because the whole subject is elapsed time between ticks.
const clock = (startMs = Date.UTC(2026, 7, 6, 12, 0, 0)) => {
  let ms = startMs;
  return {
    nowMs: () => ms,
    advance: (delta) => (ms += delta),
    runtime: (overrides = {}) => createRuntime({ now: () => ms, env: {}, pid: 4242, ...overrides }),
  };
};

const HOUR = 3600_000;

test("the first tick runs and its result comes back", async () => {
  const file = stateFile();
  const { runtime } = clock();
  const outcome = await withRefractoryPeriod(file, () => "scanned", { refractoryMs: 6 * HOUR, runtime: runtime() });
  assert.deepEqual(outcome, { ran: true, value: "scanned" });
  assert.equal(readRefractoryState(file).last_outcome, "ok");
  assert.equal(readRefractoryState(file).runs, 1);
});

test("a tick inside the refractory period is skipped, not queued", async () => {
  const file = stateFile();
  const c = clock();
  let fired = 0;
  const tick = () => withRefractoryPeriod(file, () => ++fired, { refractoryMs: 6 * HOUR, runtime: c.runtime() });

  assert.equal((await tick()).ran, true);
  c.advance(HOUR);
  const skipped = await tick();
  assert.deepEqual(skipped, { ran: false, skipped: "refractory", remainingMs: 5 * HOUR });
  assert.equal(fired, 1, "the operation must not have run a second time");

  // Skipped means dropped. Nothing is owed once the period elapses — one tick, not two.
  c.advance(6 * HOUR);
  assert.equal((await tick()).ran, true);
  assert.equal(fired, 2);
});

test("a rhythm still running is skipped as busy while the lock is held", async () => {
  const file = stateFile();
  const c = clock();
  let inner = null;

  const outer = await withRefractoryPeriod(
    file,
    async () => {
      // Re-entered from inside the locked section: this is the overrunning-rhythm case,
      // where the previous cycle has not finished and no elapsed-time check would catch it.
      inner = await withRefractoryPeriod(file, () => "should not run", { refractoryMs: 0, runtime: c.runtime() });
      return "outer done";
    },
    { refractoryMs: 0, runtime: c.runtime() },
  );

  assert.deepEqual(outer, { ran: true, value: "outer done" });
  assert.deepEqual(inner, { ran: false, skipped: "busy" });
});

test("skips are recorded so a permanently overrunning rhythm is visible", async () => {
  const file = stateFile();
  const c = clock();
  await withRefractoryPeriod(file, () => null, { refractoryMs: 6 * HOUR, runtime: c.runtime() });
  c.advance(60_000);
  await withRefractoryPeriod(file, () => null, { refractoryMs: 6 * HOUR, runtime: c.runtime(), reason: "daemon" });
  c.advance(60_000);
  await withRefractoryPeriod(file, () => null, { refractoryMs: 6 * HOUR, runtime: c.runtime(), reason: "daemon" });

  const skips = readSkipLog(file);
  assert.equal(skips.length, 2);
  assert.deepEqual(
    skips.map((entry) => [entry.skipped, entry.requested_by, entry.pid]),
    [["refractory", "daemon", 4242], ["refractory", "daemon", 4242]],
  );
  assert.equal(skips[0].at, "2026-08-06T12:01:00.000Z");
});

test("a cycle that throws still consumes its refractory period", async () => {
  const file = stateFile();
  const c = clock();
  let fired = 0;
  const boom = () =>
    withRefractoryPeriod(file, () => {
      fired += 1;
      throw new Error("planner refused");
    }, { refractoryMs: 6 * HOUR, runtime: c.runtime() });

  await assert.rejects(boom, /planner refused/);
  assert.equal(readRefractoryState(file).last_outcome, "error");
  assert.equal(readRefractoryState(file).last_error, "planner refused");

  // Without this the rhythm would re-enter on every single tick after a fast failure.
  c.advance(HOUR);
  assert.deepEqual((await boom()).skipped, "refractory");
  assert.equal(fired, 1);
});

test("a lock left behind by a dead holder is reclaimed", async () => {
  const file = stateFile();
  const c = clock();
  writeFileSync(`${file}.lock`, "999999\n");

  // mtime is *now*, so no staleMs would expire it — a rhythm's locked section can
  // legitimately run for hours, which is exactly why pid liveness decides this.
  const outcome = await withRefractoryPeriod(file, () => "recovered", {
    refractoryMs: 0,
    runtime: c.runtime({ isProcessAlive: (pid) => pid !== 999999 }),
  });
  assert.deepEqual(outcome, { ran: true, value: "recovered" });
});

test("a live holder's lock is respected however long it has been held", async () => {
  const file = stateFile();
  const c = clock();
  writeFileSync(`${file}.lock`, "777\n");
  c.advance(48 * HOUR);

  const outcome = await withRefractoryPeriod(file, () => "should not run", {
    refractoryMs: 0,
    staleMs: 1000,
    runtime: c.runtime({ isProcessAlive: (pid) => pid === 777 }),
  });
  assert.deepEqual(outcome, { ran: false, skipped: "busy" });
});

test("an unreadable state file does not wedge the rhythm", async () => {
  const file = stateFile();
  const c = clock();
  writeFileSync(file, "{ truncated");
  const outcome = await withRefractoryPeriod(file, () => "ran anyway", { refractoryMs: 6 * HOUR, runtime: c.runtime() });
  assert.deepEqual(outcome, { ran: true, value: "ran anyway" });
});
