import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createSpikeRunner,
  daemonPolicyPath,
  deleteOscillation,
  fail,
  formatDuration,
  grantCatalogCapability,
  oscillationDueness,
  oscillationsDir,
  readCapabilityPolicy,
  readCycleLog,
  readOscillation,
  readOscillations,
  readSkipLog,
  oscillationStatePath,
  requireProjectRoot,
  runOscillation,
  writeCapabilityPolicy,
  writeOscillation,
} from "@mind/core";

const usage = () => {
  console.error("usage: mind oscillation ls [--json]              (rhythms in this mind, and when each is due)");
  console.error("       mind oscillation show <id> [--json]       (definition, last cycles, skipped ticks)");
  console.error("       mind oscillation run <id> [--force]       (fire one cycle now)");
  console.error("       mind oscillation add <file.json|-> [--no-overwrite]   (define or replace a rhythm)");
  console.error("       mind oscillation rm <id> [--purge-state]  (drop a rhythm; its audit stays unless purged)");
  console.error("       mind oscillation grants                   (capabilities this mind may use unattended)");
  console.error("       mind oscillation grant <catalog> <capability>");
};

const dueLabel = (dueness) => {
  if (!dueness.lastRunAt) return "due (never run)";
  return dueness.due ? `due (last ${dueness.lastRunAt})` : `in ${formatDuration(dueness.dueInMs)}`;
};

const oscillationLs = (argv) => {
  const root = requireProjectRoot();
  const oscillations = readOscillations(root);
  const now = Date.now();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(
      oscillations.map((o) => ({ ...o, dueness: oscillationDueness(root, o, now) })),
      null,
      2,
    ));
    return;
  }
  if (!oscillations.length) {
    console.log(`(no oscillations in ${path.relative(root, oscillationsDir(root))}/)`);
    return;
  }
  for (const oscillation of oscillations) {
    const dueness = oscillationDueness(root, oscillation, now);
    const state = oscillation.enabled ? dueLabel(dueness) : "disabled";
    console.log(
      `${oscillation.id}\t${oscillation.band}\tevery ${formatDuration(oscillation.periodMs)}` +
        `\trefractory ${formatDuration(oscillation.refractoryMs)}\t${oscillation.spikes.length} spike(s)\t${state}`,
    );
  }
};

const oscillationShow = (argv) => {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) fail("usage: mind oscillation show <id>");
  const root = requireProjectRoot();
  const oscillation = readOscillation(root, id);
  const cycles = readCycleLog(root, id);
  const skips = readSkipLog(oscillationStatePath(root, id));
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ oscillation, cycles, skips }, null, 2));
    return;
  }
  console.log(`${oscillation.id} (${oscillation.band}, every ${formatDuration(oscillation.periodMs)}, ` +
    `refractory ${formatDuration(oscillation.refractoryMs)})${oscillation.enabled ? "" : " [disabled]"}`);
  if (oscillation.description) console.log(`  ${oscillation.description}`);
  for (const spike of oscillation.spikes) {
    const gates = [spike.after && `after ${spike.after}`, spike.when && `when ${spike.when}`].filter(Boolean);
    console.log(
      `  phase ${spike.phase}\t${spike.id}\t${spike.graph ? `graph:${spike.graph}` : `catalog:${spike.catalog}`}` +
        (gates.length ? `\t${gates.join(", ")}` : ""),
    );
  }
  console.log(`  ${cycles.length} recorded cycle(s), ${skips.length} skipped tick(s)`);
  for (const cycle of cycles.slice(-3)) {
    const summary = cycle.spikes.map((s) => `${s.id}=${s.state}`).join(" ");
    console.log(`  ${cycle.started_at}\t${summary}`);
  }
  // A rhythm that permanently overruns its period is only visible here, which is why the
  // skips are recorded rather than dropped.
  for (const skip of skips.slice(-3)) {
    console.log(`  ${skip.at}\tskipped: ${skip.skipped}`);
  }
};

const oscillationRun = async (argv, ctx) => {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) fail("usage: mind oscillation run <id> [--force]");
  const force = argv.includes("--force");
  const root = requireProjectRoot();
  const oscillation = readOscillation(root, id);
  const outcome = await runOscillation(root, oscillation, {
    force,
    onLog: (line) => console.error(`  ${line.level}: ${line.spike || line.oscillation}` +
      `${line.skipped ? ` skipped (${line.skipped})` : ""}${line.error ? ` — ${line.error}` : ""}`),
    runSpike: createSpikeRunner(root, { mindBinPath: ctx.cliEntry }),
  });
  if (!outcome.ran) {
    // Not an error: skipping is the designed response to a cycle that is still running or
    // that finished too recently. --force waives the window, never the running cycle.
    console.log(`${id}: skipped (${outcome.skipped})`);
    return;
  }
  for (const spike of outcome.cycle.spikes) {
    console.log(`${spike.id}\t${spike.state}${spike.skipped ? ` (${spike.skipped})` : ""}` +
      `${spike.error ? `\t${spike.error}` : ""}`);
  }
  if (outcome.cycle.spikes.some((spike) => spike.state === "error")) process.exitCode = 1;
};

const oscillationAdd = (argv) => {
  const source = argv.find((a) => !a.startsWith("--"));
  if (!source) fail("usage: mind oscillation add <file.json|-> [--no-overwrite]");
  const raw = readFileSync(source === "-" ? 0 : source, "utf8");
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    fail(`${source === "-" ? "stdin" : source} is not valid JSON (${error.message})`);
  }
  const root = requireProjectRoot();
  const written = writeOscillation(root, spec, { overwrite: !argv.includes("--no-overwrite") });
  console.log(`${written.created ? "defined" : "replaced"} ${written.id} — ${written.band} band, every ${formatDuration(written.periodMs)}`);
  console.log(`  ${path.relative(root, written.file)}`);
  console.log(`  ${written.spikes.length} spike(s): ${written.spikes.map((spike) => `${spike.id}@${spike.phase}`).join(", ")}`);
  if (!written.enabled) console.log("  disabled — the daemon will skip it until enabled is true");
};

const oscillationRm = (argv) => {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) fail("usage: mind oscillation rm <id> [--purge-state]");
  const root = requireProjectRoot();
  const removed = deleteOscillation(root, id, { purgeState: argv.includes("--purge-state") });
  console.log(`removed ${removed.id} (${path.relative(root, removed.file)})`);
  if (removed.purged.length) console.log(`  purged its state and cycle log (${removed.purged.length} file(s))`);
  else console.log("  its cycle log and last-run state are kept — pass --purge-state to drop them too");
};

const oscillationGrants = () => {
  const root = requireProjectRoot();
  const file = daemonPolicyPath(root);
  const policy = readCapabilityPolicy(file);
  const entries = Object.entries(policy.catalogGrants || {});
  if (!entries.length) {
    console.log("(no unattended grants — every capability a scheduled spike asks for will be denied)");
    console.log(`  grant one with: mind oscillation grant <catalog> <capability>`);
    return;
  }
  for (const [catalogId, capabilities] of entries) {
    console.log(`${catalogId}\t${capabilities.join(", ")}`);
  }
  console.log(`\n  ${path.relative(root, file)}`);
};

const oscillationGrant = (argv) => {
  const [catalogId, capabilityId] = argv.filter((a) => !a.startsWith("--"));
  if (!catalogId || !capabilityId) fail("usage: mind oscillation grant <catalog> <capability>");
  const root = requireProjectRoot();
  const file = daemonPolicyPath(root);
  writeCapabilityPolicy(file, grantCatalogCapability(readCapabilityPolicy(file), catalogId, capabilityId));
  console.log(`granted ${capabilityId} to ${catalogId} for unattended use`);
  console.log("  this authorizes a scheduled rhythm to run it with nobody watching.");
};

export const run = async (argv, ctx) => {
  const operation = argv[0];
  const rest = argv.slice(1);
  if (!operation || operation === "--help" || operation === "-h") return usage();
  if (operation === "ls" || operation === "list") return oscillationLs(rest);
  if (operation === "show") return oscillationShow(rest);
  if (operation === "run") return oscillationRun(rest, ctx);
  if (operation === "add" || operation === "set") return oscillationAdd(rest);
  if (operation === "rm" || operation === "remove") return oscillationRm(rest);
  if (operation === "grants") return oscillationGrants();
  if (operation === "grant") return oscillationGrant(rest);
  usage();
  fail("unknown oscillation operation: " + operation);
};
