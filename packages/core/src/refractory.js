import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { claimLockOnce, releaseLock } from "./file-lock.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { iso } from "./util.js";

// A neuron that has just fired cannot fire again until its refractory period elapses,
// no matter how hard the input pushes. A scheduled rhythm needs the same property, for
// a concrete reason: memory maintenance over a large store plans against a snapshot and
// then applies version-checked writes, so a second pass entered while the first is still
// running does not corrupt anything — it *fails*, noisily, mid-cycle, after paying for
// the planner's tokens, and leaves a maintenance record describing a pass that half
// happened.
//
// Two independent guards, because they answer different questions:
//
//   busy       — the previous cycle is still running. The lock answers this.
//   refractory — the previous cycle finished, but too recently. The state file does.
//
// A blocked rhythm is *skipped*, never queued. One missed maintenance tick is correct
// behaviour; a backlog of them is not, and a queue of overruns is exactly how a slow
// rhythm turns into an unbounded one. Skips are appended to a log next to the state so
// that a rhythm which permanently overruns its period is visible rather than silent —
// the log, not the state file, because a skipping caller by definition does not hold the
// lock and so must never write the state.
export const withRefractoryPeriod = async (
  stateFile,
  operation,
  { refractoryMs = 0, staleMs = 30000, runtime: runtimeOverride, reason = null } = {},
) => {
  const runtime = resolveRuntime(runtimeOverride);
  const lockFile = `${stateFile}.lock`;
  const descriptor = claimLockOnce(lockFile, {
    staleMs,
    now: runtime.now,
    isProcessAlive: runtime.isProcessAlive,
  });
  if (descriptor === null) return recordSkip(stateFile, "busy", runtime, reason);

  try {
    const state = readRefractoryState(stateFile);
    const sinceMs = elapsedSince(state.last_finished_at ?? state.last_started_at, runtime.now());
    if (refractoryMs > 0 && sinceMs !== null && sinceMs < refractoryMs) {
      return recordSkip(stateFile, "refractory", runtime, reason, {
        remainingMs: refractoryMs - sinceMs,
      });
    }

    const startedMs = runtime.now();
    writeState(stateFile, {
      ...state,
      last_started_at: iso(startedMs),
      last_outcome: "running",
    });
    try {
      const value = await operation();
      writeState(stateFile, {
        ...state,
        last_started_at: iso(startedMs),
        last_finished_at: iso(runtime.now()),
        last_outcome: "ok",
        last_error: null,
        runs: (state.runs || 0) + 1,
      });
      return { ran: true, value };
    } catch (error) {
      // A cycle that threw still occupied the window it occupied, so it records a
      // finish. Otherwise a rhythm that fails fast would re-enter on every tick.
      writeState(stateFile, {
        ...state,
        last_started_at: iso(startedMs),
        last_finished_at: iso(runtime.now()),
        last_outcome: "error",
        last_error: error?.message || String(error),
        runs: (state.runs || 0) + 1,
      });
      throw error;
    }
  } finally {
    releaseLock(lockFile, descriptor);
  }
};

export const readRefractoryState = (stateFile) => {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    // No state yet, or a truncated write from a killed holder. Either way the rhythm
    // has no recorded last fire, so it is free to run — refusing to run because we
    // cannot read our own bookkeeping would wedge it permanently.
    return {};
  }
};

export const readSkipLog = (stateFile) => {
  try {
    return readFileSync(skipLogPath(stateFile), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const skipLogPath = (stateFile) => `${stateFile}.skips.jsonl`;

const elapsedSince = (isoTime, nowMs) => {
  if (!isoTime) return null;
  const thenMs = Date.parse(isoTime);
  if (Number.isNaN(thenMs)) return null;
  return Math.max(0, nowMs - thenMs);
};

const writeState = (stateFile, state) => {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeJsonAtomic(stateFile, state);
};

// One `O_APPEND` write of a single short line: the kernel keeps concurrent appends from
// interleaving, which is all the atomicity a log of skips needs. Deliberately not a
// read-modify-write — every caller writing here is one that failed to take the lock.
const recordSkip = (stateFile, reason, runtime, requestReason, extra = {}) => {
  const entry = {
    at: iso(runtime.now()),
    skipped: reason,
    pid: runtime.pid,
    ...(requestReason ? { requested_by: requestReason } : {}),
    ...extra,
  };
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    appendFileSync(skipLogPath(stateFile), JSON.stringify(entry) + "\n");
  } catch {
    // Losing an audit line must not fail the tick that was already being skipped.
  }
  return { ran: false, skipped: reason, ...extra };
};
