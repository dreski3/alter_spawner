import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { kitDir, runsDir } from "./config.js";
import { readCycleLog, readOscillations } from "./oscillation.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso } from "./util.js";

// What one mind has spent, and how much room it takes up. There was no answer to either
// question before this file: tokens are recorded per run in `result.json` and nowhere
// aggregated, tool calls were not recorded at all (see harness/opencode-events.js), and
// storage was only ever the memory store's own `stats()`.
//
// The two halves are deliberately separate functions, because they are different kinds
// of number. Spend is *attributable to an interval* — a run started at a time and cost
// what it cost, so a range query over it is meaningful and cheap. Storage is a level, not
// a flow: there is no history of it on disk, so the honest answer to "storage between
// Monday and Friday" is the total right now, sampled at a stated instant. Pretending
// otherwise would mean inventing a series nobody recorded.
//
// Sampling that level costs a full directory walk — measured at 2.2s over a 5.5 GB,
// 348k-file root, which is what a real root looks like once run homes accumulate their
// own `.opencode` state. So it is async, it reports how long it took and what it counted,
// and a caller refreshing a widget is expected to cache it rather than sample per render.
export const USAGE_SCHEMA_VERSION = 1;

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 };

const emptyTokens = () => ({ ...ZERO_TOKENS });

// Accepts what a caller actually has: an ISO string, epoch milliseconds, a Date, or
// nothing at all. Null means "unbounded on that side", which is the default range.
const boundary = (value, label) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} is not a finite timestamp`);
    return value;
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) fail(`${label} is not a date this can read: ${value}`);
  return parsed;
};

export const resolveRange = ({ from = null, to = null } = {}) => {
  const fromMs = boundary(from, "from");
  const toMs = boundary(to, "to");
  if (fromMs !== null && toMs !== null && toMs < fromMs) fail("the range ends before it begins");
  return { fromMs, toMs, from: fromMs === null ? null : iso(fromMs), to: toMs === null ? null : iso(toMs) };
};

const withinRange = (ms, { fromMs, toMs }) => {
  if (ms === null) return false;
  if (fromMs !== null && ms < fromMs) return false;
  // Inclusive upper bound: a range built from a UI's "until now" would otherwise drop the
  // run that just finished.
  if (toMs !== null && ms > toMs) return false;
  return true;
};

// Run folders are named `<timestampSlug>_<id>`, and that slug is UTC and second-resolution
// (util.js). It is the fallback for a run whose `result.json` is missing or unreadable —
// an in-flight run, or one whose process died — because such a run still happened inside
// the interval and a range query that silently ignored it would under-report activity.
const FOLDER_TIMESTAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/;

export const folderTimestampMs = (folder) => {
  const match = FOLDER_TIMESTAMP.exec(folder);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const listDirectories = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

// Attempts are the unit that spent tokens, not runs: a run that failed twice and
// succeeded on the third try paid three times, and `result.json` only carries the last
// attempt's usage. Same rule as graph-result.js's aggregateTokens, on purpose — two
// different totals for one run would be a bug report waiting to happen.
const usagesOf = (result) => {
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  return attempts.length ? attempts : [result];
};

const addTokens = (into, tokens) => {
  if (!tokens) return;
  for (const key of Object.keys(ZERO_TOKENS)) into[key] += tokens[key] || 0;
};

const addTools = (into, tools) => {
  if (!tools) return;
  into.calls += tools.calls || 0;
  into.errors += tools.errors || 0;
  for (const [name, count] of Object.entries(tools.by_name || tools.byName || {})) {
    into.by_name[name] = (into.by_name[name] || 0) + count;
  }
};

const bucket = (map, key) => {
  const id = key || "(none)";
  if (!map[id]) map[id] = { runs: 0, tokens: emptyTokens(), tools: { calls: 0, errors: 0, by_name: {} } };
  return map[id];
};

// One run's contribution, from its folder. Exported because the range filter is the
// interesting part to test and it needs no directory tree to exercise.
export const summarizeRunFolder = (home, folder) => {
  const result = readJson(path.join(home, "result.json"));
  const startedMs = result?.started_at ? Date.parse(result.started_at) : NaN;
  const at = Number.isNaN(startedMs) ? folderTimestampMs(folder) : startedMs;
  if (!result) {
    // No result.json: the run is in flight, or its process died before writing one. It
    // occupies the interval and cost something unknowable, so it is counted and its
    // spend is not guessed.
    return { folder, at, complete: false, ok: false, tokens: null, tools: null, catalog: null, model: null, executor: null };
  }
  const tokens = emptyTokens();
  const tools = { calls: 0, errors: 0, by_name: {} };
  let toolsKnown = false;
  for (const usage of usagesOf(result)) {
    addTokens(tokens, usage?.tokens);
    if (usage?.tools) {
      addTools(tools, usage.tools);
      toolsKnown = true;
    }
  }
  return {
    folder,
    at,
    complete: true,
    ok: result.ok === true,
    tokens,
    // Null, not zero, for a run that predates tool accounting or ran on an executor
    // without tools. "No tools were called" and "nobody counted" must not read alike.
    tools: toolsKnown ? tools : null,
    catalog: result.catalog || null,
    model: result.model || null,
    executor: result.executor || null,
  };
};

// Spend over an interval: tokens, tool calls, and how the runs that produced them break
// down. Synchronous and cheap — one small JSON read per run folder — so a widget may call
// this on every refresh.
//
// Only `.alters/runs/` is walked. `.alters/graphs/` holds graph documents that *embed* a
// copy of every node's result, and each of those nodes ran in its own folder under
// `runs/` (graph.js), so counting both would double every graph's tokens.
export const readSpendUsage = (root, options = {}) => {
  const range = resolveRange(options);
  const dir = runsDir(root);
  const totals = {
    runs: 0,
    completed: 0,
    failed: 0,
    incomplete: 0,
    tokens: emptyTokens(),
    tools: { calls: 0, errors: 0, by_name: {} },
    runs_without_tool_data: 0,
  };
  const byCatalog = {};
  const byModel = {};
  const byExecutor = {};
  let firstMs = null;
  let lastMs = null;
  let undatable = 0;

  for (const folder of listDirectories(dir)) {
    const home = path.join(dir, folder);
    if (!existsSync(path.join(home, "alter.json")) && !existsSync(path.join(home, "result.json"))) continue;
    const summary = summarizeRunFolder(home, folder);
    if (summary.at === null) {
      // Neither a parseable `started_at` nor a timestamped folder name. Reported rather
      // than dropped: an unattributable run is a data problem worth seeing, and silently
      // excluding it would make the totals quietly wrong.
      undatable += 1;
      continue;
    }
    if (!withinRange(summary.at, range)) continue;

    totals.runs += 1;
    if (!summary.complete) totals.incomplete += 1;
    else if (summary.ok) totals.completed += 1;
    else totals.failed += 1;
    addTokens(totals.tokens, summary.tokens);
    if (summary.tools) addTools(totals.tools, summary.tools);
    else if (summary.complete) totals.runs_without_tool_data += 1;

    for (const [map, key] of [[byCatalog, summary.catalog], [byModel, summary.model], [byExecutor, summary.executor]]) {
      const entry = bucket(map, key);
      entry.runs += 1;
      addTokens(entry.tokens, summary.tokens);
      addTools(entry.tools, summary.tools);
    }
    if (firstMs === null || summary.at < firstMs) firstMs = summary.at;
    if (lastMs === null || summary.at > lastMs) lastMs = summary.at;
  }

  return {
    ...totals,
    undatable_runs: undatable,
    first_run_at: firstMs === null ? null : iso(firstMs),
    last_run_at: lastMs === null ? null : iso(lastMs),
    by_catalog: byCatalog,
    by_model: byModel,
    by_executor: byExecutor,
  };
};

// What the rhythms did in the interval. The daemon's own audit is the cycle log
// (oscillation.js), so this is a read over those lines rather than a second ledger: it is
// how a host answers "did my oscillation actually fire, and what came out of it" without
// tailing a file.
export const readOscillationActivity = (root, options = {}) => {
  const range = resolveRange(options);
  const activity = [];
  for (const oscillation of readOscillations(root)) {
    const cycles = readCycleLog(root, oscillation.id).filter((cycle) => {
      const at = Date.parse(cycle.started_at || "");
      return withinRange(Number.isNaN(at) ? null : at, range);
    });
    const spikes = cycles.flatMap((cycle) => cycle.spikes || []);
    activity.push({
      id: oscillation.id,
      band: oscillation.band,
      enabled: oscillation.enabled !== false,
      cycles: cycles.length,
      spikes: spikes.length,
      spikes_ok: spikes.filter((spike) => spike.state === "ok").length,
      spikes_error: spikes.filter((spike) => spike.state === "error").length,
      spikes_skipped: spikes.filter((spike) => spike.state === "skipped").length,
      last_cycle_at: cycles.length ? cycles[cycles.length - 1].started_at : null,
    });
  }
  return activity;
};

// One pass over the tree, attributing every file to a component as it goes. A component
// is a property of the *directory* a file sits in, so it is decided once per directory and
// carried down rather than re-derived per file — which is what lets the whole breakdown
// cost the same walk as the total. Walking the root and then each component separately
// measured 3.6s against 2.2s for this, because it read the big subtrees twice.
const walkTree = async (root, componentOf) => {
  const totals = { bytes: 0, files: 0 };
  const components = {};
  const credit = (name, bytes) => {
    // `null` is the "resolve my children by name" sentinel a classifier may return for a
    // container directory; a file sitting directly in one belongs to no named part.
    const component = name ?? "other";
    if (!components[component]) components[component] = { bytes: 0, files: 0 };
    components[component].bytes += bytes;
    components[component].files += 1;
    totals.bytes += bytes;
    totals.files += 1;
  };
  let queue = [{ dir: root, component: componentOf(root, null) }];
  while (queue.length) {
    // Breadth-first in batches: one `readdir` per directory is unavoidable, but issuing
    // them together is what takes the walk from ~4.8s to ~2.2s on a real root. The batch
    // size is a bound on open descriptors, not a tuning knob worth exposing.
    const batch = queue.splice(0, 32);
    const listings = await Promise.all(
      batch.map(async (entry) => {
        try {
          return { ...entry, entries: await readdir(entry.dir, { withFileTypes: true }) };
        } catch {
          // Unreadable or vanished mid-walk. A size that dies on one bad directory is
          // worse than one that reports what it could reach.
          return { ...entry, entries: [] };
        }
      }),
    );
    const targets = [];
    for (const { dir, component, entries } of listings) {
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push({ dir: full, component: componentOf(full, component) });
        // Symlinks are deliberately not followed and not counted: their target is
        // somebody else's bytes, and following them invites a cycle.
        else if (entry.isFile()) targets.push({ full, component });
      }
    }
    for (let i = 0; i < targets.length; i += 64) {
      const slice = targets.slice(i, i + 64);
      const sizes = await Promise.all(
        slice.map(async ({ full }) => {
          try {
            return (await stat(full)).size;
          } catch {
            return 0;
          }
        }),
      );
      sizes.forEach((size, index) => credit(slice[index].component, size));
    }
  }
  return { ...totals, components };
};

// How much room this mind occupies, right now. Everything under the root counts —
// the alters and their manifests, whatever the run homes accumulated, the installed
// packages, the memory store — because that is what the mind costs on the disk, and a
// number that excluded the parts nobody chose to write would not be the number anyone
// wants when deciding whether to prune.
//
// `memory` is broken out of the total rather than reported alongside it: the interesting
// comparison is "of everything this mind occupies, how much is what it remembers".
export const STORAGE_COMPONENTS = Object.freeze(["memory", "runs", "graphs", "trees", "state", "oscillations", "catalog", "other"]);

export const readStorageUsage = async (root, { runtime: runtimeOverride } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const startedMs = runtime.now();
  const kit = kitDir(root);
  // The named parts are the top level of `.alters/` only. A run home nests its own
  // `.alters/`, and those bytes belong to `runs` — the parent's history — rather than to
  // whatever the child called them, which is why a component is inherited from the parent
  // directory instead of being matched against the path at every depth.
  const owners = new Map(
    STORAGE_COMPONENTS.filter((name) => name !== "other").map((name) => [path.join(kit, name), name]),
  );
  const walked = await walkTree(root, (dir, inherited) => {
    // `.alters/` itself resolves its children by name; everything else — the project's own
    // files, `node_modules`, `AGENTS.md` — is `other`, which is what the null sentinel
    // credits a directly-contained file to.
    if (dir === kit) return null;
    if (inherited != null) return inherited;
    return owners.get(dir) ?? null;
  });

  const components = {};
  for (const name of STORAGE_COMPONENTS) components[name] = walked.components[name] || { bytes: 0, files: 0 };

  return {
    total_bytes: walked.bytes,
    memory_bytes: components.memory.bytes,
    files: walked.files,
    components,
    sampled_at: iso(runtime.now()),
    // A level, not a flow: this number describes the instant it was taken and no
    // interval. Stated in the payload so a caller cannot accidentally present it as a
    // range total.
    sample_duration_ms: runtime.now() - startedMs,
  };
};

// The whole picture for one mind. `storage: false` skips the expensive half, which is the
// right call for a caller refreshing token counts on a timer.
export const readUsage = async (root, { from = null, to = null, storage = true, runtime } = {}) => {
  const range = resolveRange({ from, to });
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    root,
    range: { from: range.from, to: range.to },
    spend: readSpendUsage(root, range),
    oscillations: readOscillationActivity(root, range),
    storage: storage ? await readStorageUsage(root, { runtime }) : null,
  };
};
