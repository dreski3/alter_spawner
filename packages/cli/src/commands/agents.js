import path from "node:path";
import {
  addRegistryInput,
  fail,
  isMindRoot,
  listMinds,
  mindHomeDir,
  readRegistry,
  readRegistryConfig,
  registryConfigPath,
  removeRegistryInput,
  resolveMind,
  scanRegistry,
} from "@mind/core";

const usage = () => {
  console.error("usage: mind agents ls [--json]                (list registered minds)");
  console.error("       mind agents scan [--json] [--depth <n>] [--no-adopt]");
  console.error("       mind agents add <dir> [--workspace]    (root by default; --workspace scans it)");
  console.error("       mind agents rm <dir>                   (drop a workspace or root from the inputs)");
  console.error("       mind agents where <agent-id|name>      (print a mind's root)");
};

const relativeToHome = (target) => {
  const home = process.env.HOME;
  return home && target.startsWith(home + path.sep) ? "~" + target.slice(home.length) : target;
};

const reportConflicts = (conflicts) => {
  if (!conflicts.length) return;
  console.error("");
  for (const conflict of conflicts) {
    console.error(`warning: two roots claim agent_id ${conflict.agentId}`);
    console.error(`  kept:    ${relativeToHome(conflict.kept)}`);
    console.error(`  ignored: ${relativeToHome(conflict.ignored)}`);
  }
  console.error("  a copied mind carries its identity. To make the copy its own mind:");
  console.error("    (cd <copy> && mind init --force --new-identity)   # forfeits the original's memory");
  console.error("  otherwise delete one of them and rescan.");
};

const agentsLs = async (argv) => {
  const json = argv.includes("--json");
  const rebuilt = readRegistry() === null;
  const minds = await listMinds();
  if (json) {
    console.log(JSON.stringify({ minds, registry_rebuilt: rebuilt }, null, 2));
    return;
  }
  if (!minds.length) {
    const { workspaces, roots } = readRegistryConfig();
    console.log("(no minds registered)");
    console.log(`  looked in: ${workspaces.map(relativeToHome).join(", ") || "(none)"}`);
    if (roots.length) console.log(`  roots:     ${roots.map(relativeToHome).join(", ")}`);
    console.log(`  add one with: mind agents add <dir> --workspace`);
    return;
  }
  for (const mind of minds) {
    console.log(`${mind.agentId}\t${mind.name}\t${relativeToHome(mind.root)}\t${mind.last_seen}`);
  }
  if (rebuilt) console.log(`\n(index was missing and has been rebuilt — ${mindHomeDir()})`);
};

const agentsScan = async (argv) => {
  let json = false;
  let adopt = true;
  let maxDepth;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--no-adopt") adopt = false;
    else if (argv[i] === "--depth") maxDepth = Number(argv[++i]);
    else fail("unknown flag: " + argv[i]);
  }
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    fail("--depth must be a non-negative integer");
  }
  const result = await scanRegistry({ adopt, maxDepth });
  const count = Object.keys(result.index.agents).length;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`scanned ${result.workspaces.length} workspace(s): ${count} mind(s) registered`);
  for (const [agentId, entry] of Object.entries(result.index.agents)) {
    console.log(`  ${entry.name}\t${agentId}\t${relativeToHome(entry.root)}`);
  }
  for (const entry of result.adopted) {
    console.log(`  adopted ${relativeToHome(entry.root)} (minted agent_id ${entry.agentId})`);
  }
  for (const root of result.missing) {
    console.log(`  missing: ${relativeToHome(root)} is listed as a root but has no .alters/config.json`);
  }
  reportConflicts(result.conflicts);
};

const agentsAdd = async (argv) => {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const asWorkspace = argv.includes("--workspace");
  const dir = positional[0];
  if (!dir) fail("usage: mind agents add <dir> [--workspace]");
  const resolved = path.resolve(dir);
  if (!asWorkspace && !isMindRoot(resolved)) {
    fail(`not a mind project: ${dir} (no .alters/config.json). Pass --workspace to scan it for minds instead.`);
  }
  const added = addRegistryInput(asWorkspace ? "workspace" : "root", resolved);
  console.log(
    added.added
      ? `added ${added.target === "workspaces" ? "workspace" : "root"}: ${relativeToHome(added.path)}`
      : `already listed: ${relativeToHome(added.path)}`,
  );
  const result = await scanRegistry({});
  console.log(`  ${Object.keys(result.index.agents).length} mind(s) registered`);
  reportConflicts(result.conflicts);
};

const agentsRm = async (argv) => {
  const dir = argv.filter((a) => !a.startsWith("--"))[0];
  if (!dir) fail("usage: mind agents rm <dir>");
  const result = removeRegistryInput(dir);
  if (!result.removed) {
    fail(`not listed in ${registryConfigPath()}: ${relativeToHome(result.path)}`);
  }
  console.log(`removed from the registry inputs: ${relativeToHome(result.path)}`);
  console.log("  (the mind itself is untouched)");
  const scan = await scanRegistry({});
  console.log(`  ${Object.keys(scan.index.agents).length} mind(s) registered`);
};

const agentsWhere = async (argv) => {
  const needle = argv[0];
  if (!needle) fail("usage: mind agents where <agent-id|name>");
  const mind = await resolveMind(needle);
  console.log(mind.root);
};

export const run = async (argv) => {
  const operation = argv[0];
  const rest = argv.slice(1);
  if (!operation || operation === "--help" || operation === "-h") {
    usage();
    return;
  }
  if (operation === "ls" || operation === "list") return agentsLs(rest);
  if (operation === "scan") return agentsScan(rest);
  if (operation === "add") return agentsAdd(rest);
  if (operation === "rm" || operation === "remove") return agentsRm(rest);
  if (operation === "where") return agentsWhere(rest);
  usage();
  fail("unknown agents operation: " + operation);
};
