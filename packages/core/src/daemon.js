import path from "node:path";
import {
  createCapabilityApprovalSession,
  hasCatalogGrant,
  readCapabilityPolicy,
} from "./capabilities.js";
import { kitDir } from "./config.js";
import { spawnAlter } from "./engine.js";
import { createMemoryCapabilityRegistry } from "./memory-capabilities.js";
import { runMemoryMaintenanceGraph } from "./memory-maintenance.js";
import { createProjectMemoryStore } from "./memory.js";
import { oscillationDueness, readOscillations, runOscillation } from "./oscillation.js";
import { listMinds, touchMind } from "./registry.js";
import { resolveRuntime } from "./runtime.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { iso } from "./util.js";

// Grants that authorize *unattended* capability use, per mind. Deliberately not the same
// file as the host's interactive policy: approving a memory write once, in a chat, with a
// card in front of you, is not the same act as authorizing a rhythm to do it every six
// hours while you sleep. Nothing here is granted by default, and an ungranted capability
// denies immediately rather than waiting for a card nobody will see.
export const daemonPolicyPath = (root) => path.join(kitDir(root), "state", "daemon-policy.json");

export const BUILTIN_GRAPHS = Object.freeze(["memory-maintenance"]);

// The production `runSpike`. Two kinds of spike: a builtin graph, or a catalog entry
// spawned as a one-shot Alter.
export const createSpikeRunner = (root, { runtime, mindBinPath = null, signal, onEvent } = {}) => {
  return async ({ spike, oscillation }) => {
    if (spike.graph) {
      if (spike.graph !== "memory-maintenance") {
        throw new Error(`unknown builtin graph ${spike.graph} (available: ${BUILTIN_GRAPHS.join(", ")})`);
      }
      const store = createProjectMemoryStore(root);
      const registry = createMemoryCapabilityRegistry({ store, grantable: true });
      const policy = readCapabilityPolicy(daemonPolicyPath(root));
      const catalogId = spike.options.catalog || "memory-manager";
      const approvals = createCapabilityApprovalSession({
        registry,
        catalogId,
        signal,
        unattended: true,
        isPersistentlyApproved: ({ capabilityId }) => hasCatalogGrant(policy, catalogId, capabilityId),
      });
      return runMemoryMaintenanceGraph(root, {
        scope: { project: store.projectId },
        approvals,
        allowDeletes: spike.options.allowDeletes === true,
        compact: spike.options.compact !== false,
        graph: { id: `${oscillation.id}_${spike.id}`, ...(spike.options.graph || {}) },
        mindBinPath,
        runtime,
        signal,
        onEvent,
      });
    }
    const options = createSpawnOptions({
      catalog: spike.catalog,
      name: `${oscillation.id}_${spike.id}`,
      prompt: spike.prompt || `Scheduled spike ${spike.id} of the ${oscillation.id} oscillation.`,
      ...spike.options,
    });
    options.mindBinPath = mindBinPath;
    return spawnAlter(root, options, { runtime, signal, onEvent });
  };
};

// One pass over every (mind, oscillation) pair. This is the entire daemon: it reads the
// registry, and for each due oscillation calls core with that mind's root. It holds no
// state a rescan could not rebuild.
export const runDaemonTick = async ({
  env = process.env,
  runtime: runtimeOverride,
  mindBinPath = null,
  signal,
  dryRun = false,
  force = false,
  only = null,
  onLog = () => {},
  runSpike = null,
} = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const startedMs = runtime.now();
  const minds = await listMinds({ env, runtime });
  const filtered = only ? minds.filter((mind) => mind.agentId === only || mind.name === only) : minds;

  // Minds run concurrently, oscillations within a mind sequentially. A mind whose cycle
  // takes hours must not stop every other mind from being ticked, which a sequential
  // outer loop would do; within one mind, sequential keeps a tick from spawning every
  // rhythm's models at once against the same root.
  const results = await Promise.all(
    filtered.map(async (mind) => {
      const report = { agentId: mind.agentId, name: mind.name, root: mind.root, oscillations: [], error: null };
      try {
        const oscillations = readOscillations(mind.root);
        for (const oscillation of oscillations) {
          const entry = { id: oscillation.id, band: oscillation.band };
          if (!oscillation.enabled) {
            report.oscillations.push({ ...entry, action: "disabled" });
            continue;
          }
          const dueness = oscillationDueness(mind.root, oscillation, runtime.now());
          if (!dueness.due && !force) {
            report.oscillations.push({ ...entry, action: "not-due", dueInMs: dueness.dueInMs });
            continue;
          }
          if (dryRun) {
            report.oscillations.push({ ...entry, action: "would-run", lastRunAt: dueness.lastRunAt });
            continue;
          }
          onLog({ level: "info", mind: mind.name, oscillation: oscillation.id, message: "firing" });
          const outcome = await runOscillation(mind.root, oscillation, {
            runtime,
            signal,
            force,
            onLog: (line) => onLog({ ...line, mind: mind.name }),
            runSpike: runSpike || createSpikeRunner(mind.root, { runtime, mindBinPath, signal }),
          });
          report.oscillations.push({
            ...entry,
            action: outcome.ran ? "ran" : "skipped",
            skipped: outcome.skipped ?? null,
            spikes: outcome.cycle?.spikes ?? null,
          });
        }
        if (!dryRun) await touchMind(mind.agentId, { env, runtime });
      } catch (error) {
        // One mind's bad oscillation file must not end the tick for every other mind.
        report.error = error?.message || String(error);
        onLog({ level: "error", mind: mind.name, error: report.error });
      }
      return report;
    }),
  );

  return {
    started_at: iso(startedMs),
    finished_at: iso(runtime.now()),
    minds: results,
    fired: results.flatMap((mind) => mind.oscillations).filter((entry) => entry.action === "ran").length,
  };
};

// The loop. Kept trivial on purpose: everything interesting is in one tick, so running
// the daemon under launchd/systemd with `--once` on a timer and running it as a long-lived
// loop exercise the same code path.
export const runDaemon = async ({
  intervalMs = 60_000,
  signal,
  onTick = () => {},
  onLog = () => {},
  runtime: runtimeOverride,
  ...tickOptions
} = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  let ticks = 0;
  while (!signal?.aborted) {
    const tick = await runDaemonTick({ ...tickOptions, runtime, signal, onLog });
    ticks += 1;
    onTick(tick);
    if (signal?.aborted) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  return { ticks };
};
