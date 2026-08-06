import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { withRefractoryPeriod, readRefractoryState } from "./refractory.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso } from "./util.js";

export const OSCILLATION_SCHEMA_VERSION = 1;

// Brain rhythms do not compute; they *schedule* computation. That is the whole job here:
// an oscillation owns no work of its own, it decides when spikes fire and in what order.
//
// A band is a frequency class, and it is documentation plus a default period — nothing
// more. The reason to name them at all is that the interesting behaviour is
// cross-frequency: a slow rhythm gating fast ones (nightly maintenance gating per-turn
// curation) is the pattern this vocabulary exists to make sayable.
export const BANDS = Object.freeze({
  fast: "5m",
  medium: "1h",
  slow: "6h",
  circadian: "24h",
});

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Accepts "6h", "30m", "500ms", "1d", or a plain number of milliseconds. Deliberately
// not a cron expression: a period plus a phase offset covers every rhythm this schedules,
// and cron's calendar semantics ("first Monday") would need a calendar the daemon has no
// reason to own.
export const parseDuration = (value, label = "duration") => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number of ms`);
    return Math.floor(value);
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string like "6h" or a number of ms`);
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`${label} is not a duration: ${JSON.stringify(value)} (try "30m", "6h", "1d")`);
  return Math.floor(Number(match[1]) * DURATION_UNITS[match[2]]);
};

export const formatDuration = (ms) => {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]]) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
};

export const oscillationsDir = (root) => path.join(kitDir(root), "oscillations");

// State is run-local — when a rhythm last fired, which ticks it skipped, what each cycle
// did. It lives apart from the definitions because the definitions are authored config
// that belongs in version control and this emphatically does not.
export const oscillationStateDir = (root) => path.join(kitDir(root), "state", "oscillations");
export const oscillationStatePath = (root, id) => path.join(oscillationStateDir(root), `${id}.json`);
const cycleLogPath = (root, id) => path.join(oscillationStateDir(root), `${id}.cycles.jsonl`);

const SPIKE_KINDS = ["graph", "catalog"];

export const validateOscillation = (raw, { source = "oscillation" } = {}) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} must be a JSON object`);
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) throw new Error(`${source} needs an id`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`${source}: id must be alphanumeric with - or _ (got ${id})`);

  if (raw.band !== undefined && !Object.hasOwn(BANDS, raw.band)) {
    throw new Error(`${id}: unknown band ${JSON.stringify(raw.band)} (one of ${Object.keys(BANDS).join(", ")})`);
  }
  const band = raw.band || "medium";
  const periodMs = parseDuration(raw.period ?? BANDS[band], `${id}: period`);
  if (periodMs <= 0) throw new Error(`${id}: period must be greater than zero`);
  // Defaults to the period, which is the case that needs no thought: a rhythm should not
  // re-enter within its own cycle. A shorter refractory is for a rhythm something else
  // can trigger off-schedule; a longer one is a floor the schedule cannot override.
  const refractoryMs = raw.refractory === undefined ? periodMs : parseDuration(raw.refractory, `${id}: refractory`);

  if (!Array.isArray(raw.spikes) || raw.spikes.length === 0) throw new Error(`${id}: needs at least one spike`);
  const spikes = [];
  const byId = new Map();
  for (const [index, entry] of raw.spikes.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${id}: spike ${index} must be an object`);
    }
    const spikeId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!spikeId) throw new Error(`${id}: spike ${index} needs an id`);
    if (byId.has(spikeId)) throw new Error(`${id}: duplicate spike id ${spikeId}`);
    const kinds = SPIKE_KINDS.filter((kind) => entry[kind]);
    if (kinds.length !== 1) {
      throw new Error(`${id}: spike ${spikeId} needs exactly one of ${SPIKE_KINDS.join(" / ")} (got ${kinds.length})`);
    }
    const phase = entry.phase === undefined ? 0 : entry.phase;
    if (!Number.isInteger(phase) || phase < 0) throw new Error(`${id}: spike ${spikeId} phase must be a whole number >= 0`);
    const spike = {
      id: spikeId,
      phase,
      graph: entry.graph || null,
      catalog: entry.catalog || null,
      prompt: entry.prompt || null,
      after: entry.after || null,
      when: entry.when || null,
      options: entry.options && typeof entry.options === "object" ? entry.options : {},
    };
    spikes.push(spike);
    byId.set(spikeId, spike);
  }

  // Both `after` and `when` may only look backwards. Same phase means parallel, and a
  // spike cannot read a result from something running beside it — allowing it would make
  // the outcome depend on which of two concurrent spikes happened to finish first.
  for (const spike of spikes) {
    for (const [field, reference] of [["after", spike.after], ["when", spike.when?.split(".")[0]]]) {
      if (!reference) continue;
      const target = byId.get(reference);
      if (!target) throw new Error(`${id}: spike ${spike.id} ${field}s unknown spike ${reference}`);
      if (target.phase >= spike.phase) {
        throw new Error(
          `${id}: spike ${spike.id} ${field}s ${reference}, which is in phase ${target.phase} — ` +
            `it must be in an earlier phase than ${spike.phase}`,
        );
      }
    }
  }

  return {
    schema_version: OSCILLATION_SCHEMA_VERSION,
    id,
    band,
    periodMs,
    refractoryMs,
    enabled: raw.enabled !== false,
    description: raw.description || null,
    spikes,
  };
};

export const readOscillations = (root) => {
  const dir = oscillationsDir(root);
  let entries = [];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return entries.map((name) => {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`${path.join("oscillations", name)} is not valid JSON (${error.message})`);
    }
    // The filename is the fallback id, so a one-field file is a valid rhythm.
    return { ...validateOscillation({ id: path.basename(name, ".json"), ...raw }, { source: name }), file };
  });
};

export const readOscillation = (root, id) => {
  const found = readOscillations(root).find((oscillation) => oscillation.id === id);
  if (!found) fail(`no oscillation named ${id} in ${path.relative(root, oscillationsDir(root))}/`);
  return found;
};

// Due-ness and the refractory period answer different questions, which is why both exist.
// This one is the *schedule*: has a period elapsed since the last cycle. The refractory
// lock is the *floor*: it refuses re-entry even when something other than the schedule
// asks. With the default refractory they coincide, and that is fine — the distinction
// only shows up once a rhythm is coupled to an event.
export const oscillationDueness = (root, oscillation, nowMs) => {
  const state = readRefractoryState(oscillationStatePath(root, oscillation.id));
  const last = state.last_finished_at || state.last_started_at || null;
  if (!last) return { due: true, lastRunAt: null, elapsedMs: null, dueInMs: 0 };
  const elapsedMs = Math.max(0, nowMs - Date.parse(last));
  if (Number.isNaN(elapsedMs)) return { due: true, lastRunAt: last, elapsedMs: null, dueInMs: 0 };
  return {
    due: elapsedMs >= oscillation.periodMs,
    lastRunAt: last,
    elapsedMs,
    dueInMs: Math.max(0, oscillation.periodMs - elapsedMs),
  };
};

const readPath = (value, dotted) =>
  dotted.split(".").slice(1).reduce((current, key) => (current == null ? current : current[key]), value);

const appendCycle = (root, id, record) => {
  try {
    mkdirSync(oscillationStateDir(root), { recursive: true });
    appendFileSync(cycleLogPath(root, id), JSON.stringify(record) + "\n");
  } catch {
    // The cycle happened whether or not its audit line landed. Losing the line must not
    // fail the cycle.
  }
};

export const readCycleLog = (root, id) => {
  try {
    return readFileSync(cycleLogPath(root, id), "utf8")
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

// Runs one cycle of one oscillation, inside the refractory lock.
//
// `runSpike` is injected rather than resolved here so that the scheduling — phase order,
// coupling, what a failure does to the rest of the cycle — is testable without spawning a
// model. `createSpikeRunner` below is the production one.
export const runOscillation = async (
  root,
  oscillation,
  { runtime: runtimeOverride, runSpike, force = false, signal, onLog = () => {} } = {},
) => {
  const runtime = resolveRuntime(runtimeOverride);
  if (typeof runSpike !== "function") throw new Error("runOscillation needs a runSpike function");
  const stateFile = oscillationStatePath(root, oscillation.id);

  // `force` waives the refractory *window* — the "it finished too recently" check. It
  // cannot waive the busy lock, and should not: that one is not a policy, it is the fact
  // that a cycle is still running.
  const outcome = await withRefractoryPeriod(
    stateFile,
    async () => {
      const startedMs = runtime.now();
      const results = {};
      const spikeRecords = [];
      const phases = [...new Set(oscillation.spikes.map((spike) => spike.phase))].sort((a, b) => a - b);

      for (const phase of phases) {
        const group = oscillation.spikes.filter((spike) => spike.phase === phase);
        // Same phase = parallel. One spike's failure must not cancel its siblings — they
        // were declared independent by being given the same phase.
        const settled = await Promise.all(
          group.map(async (spike) => {
            const gate = evaluateGate(spike, results, spikeRecords);
            if (gate) {
              onLog({ level: "debug", oscillation: oscillation.id, spike: spike.id, skipped: gate });
              return { id: spike.id, phase, state: "skipped", skipped: gate, result: null, error: null };
            }
            const spikeStart = runtime.now();
            try {
              const result = await runSpike({ spike, root, oscillation, results, signal });
              results[spike.id] = result ?? null;
              return {
                id: spike.id,
                phase,
                state: "ok",
                duration_ms: runtime.now() - spikeStart,
                result: summarizeSpikeResult(result),
                error: null,
              };
            } catch (error) {
              onLog({ level: "error", oscillation: oscillation.id, spike: spike.id, error: error?.message });
              return {
                id: spike.id,
                phase,
                state: "error",
                duration_ms: runtime.now() - spikeStart,
                result: null,
                error: error?.message || String(error),
              };
            }
          }),
        );
        spikeRecords.push(...settled);
      }

      const cycle = {
        schema_version: OSCILLATION_SCHEMA_VERSION,
        oscillation: oscillation.id,
        band: oscillation.band,
        forced: force,
        started_at: iso(startedMs),
        finished_at: iso(runtime.now()),
        spikes: spikeRecords,
      };
      appendCycle(root, oscillation.id, cycle);
      return cycle;
    },
    {
      refractoryMs: force ? 0 : oscillation.refractoryMs,
      runtime,
      reason: force ? "forced" : "schedule",
    },
  );

  if (!outcome.ran) {
    onLog({ level: "info", oscillation: oscillation.id, skipped: outcome.skipped });
    return { ran: false, skipped: outcome.skipped, cycle: null };
  }
  return { ran: true, cycle: outcome.value };
};

// `after` means the named spike ran and succeeded; `when` means a value it produced is
// truthy. Together they read as "compact only if scan succeeded and actually freed
// space". `when` is a dotted path and a truthiness test, and stays that way on purpose —
// an expression language in a scheduler is a place for logic to hide, and the thinking
// belongs in the alters the spikes run.
const evaluateGate = (spike, results, records) => {
  if (spike.after) {
    const record = records.find((entry) => entry.id === spike.after);
    if (!record || record.state !== "ok") return `after:${spike.after}`;
  }
  if (spike.when) {
    const source = spike.when.split(".")[0];
    if (!Object.hasOwn(results, source)) return `when:${spike.when}`;
    if (!readPath(results[source], spike.when)) return `when:${spike.when}`;
  }
  return null;
};

// A cycle record is an audit line, not a transcript: a graph result carries every node's
// full output and would bloat the log without telling anyone what happened.
const summarizeSpikeResult = (result) => {
  if (result == null || typeof result !== "object") return result ?? null;
  const summary = {};
  if (result.home) summary.home = result.home;
  if (result.result?.ok !== undefined) summary.ok = result.result.ok;
  if (result.res?.ok !== undefined) summary.ok = result.res.ok;
  if (result.committed !== undefined) summary.committed = result.committed;
  if (Array.isArray(result.records)) summary.records = result.records.length;
  if (Array.isArray(result.plan)) summary.operations = result.plan.length;
  if (result.storage) summary.storage = result.storage;
  return Object.keys(summary).length ? summary : null;
};
