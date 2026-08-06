import {
  fail,
  formatDuration,
  parseDuration,
  readUsage,
  requireProjectRoot,
  resolveMind,
} from "@mind/core";

const usage = () => {
  console.error("usage: mind usage [--from <when>] [--to <when>] [--since <dur>] [--mind <id|name>] [--no-storage] [--json]");
  console.error("");
  console.error("  What this mind has spent, and how much room it takes up. `--since 24h` is the");
  console.error("  common case; --from/--to take anything Date.parse reads (\"2026-08-06\").");
  console.error("  Storage is a level, not a range total, and sampling it walks the whole project —");
  console.error("  pass --no-storage for a cheap tokens-and-tools read.");
};

const bytes = (value) => {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
};

const count = (value) => value.toLocaleString("en-US");

const describe = (report) => {
  const { spend, storage } = report;
  const window = [report.range.from || "the beginning", report.range.to || "now"].join(" -> ");
  console.log(`window:   ${window}`);
  console.log(`runs:     ${count(spend.runs)} (${spend.completed} ok, ${spend.failed} failed, ${spend.incomplete} unfinished)`);
  console.log(
    `tokens:   ${count(spend.tokens.total)} total` +
      ` (in ${count(spend.tokens.input)}, out ${count(spend.tokens.output)}` +
      `, reasoning ${count(spend.tokens.reasoning)}, cached ${count(spend.tokens.cache_read)})`,
  );
  const tools = Object.entries(spend.tools.by_name).sort((a, b) => b[1] - a[1]);
  console.log(
    `tools:    ${count(spend.tools.calls)} calls${spend.tools.errors ? `, ${spend.tools.errors} failed` : ""}` +
      (tools.length ? ` — ${tools.map(([name, n]) => `${name} ${n}`).join(", ")}` : ""),
  );
  // Said out loud rather than left to inference: a zero here usually means "these runs
  // predate tool accounting", not "this mind called no tools".
  if (spend.runs_without_tool_data) {
    console.log(`          (${spend.runs_without_tool_data} run(s) recorded no tool data — they predate it, or ran a tool-less executor)`);
  }
  if (spend.undatable_runs) console.log(`          (${spend.undatable_runs} run(s) could not be dated and are excluded)`);

  if (storage) {
    console.log(`storage:  ${bytes(storage.total_bytes)} across ${count(storage.files)} files — of which memory ${bytes(storage.memory_bytes)}`);
    const parts = Object.entries(storage.components)
      .filter(([, part]) => part.bytes > 0)
      .sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [name, part] of parts) console.log(`            ${name.padEnd(12)} ${bytes(part.bytes)}`);
    console.log(`          (sampled ${storage.sampled_at}, took ${formatDuration(storage.sample_duration_ms)} — a level, not a range total)`);
  }

  const active = report.oscillations.filter((entry) => entry.cycles > 0);
  if (report.oscillations.length) {
    console.log(`rhythms:  ${report.oscillations.length} defined, ${active.length} fired in this window`);
    for (const entry of report.oscillations) {
      const detail = entry.cycles
        ? `${entry.cycles} cycle(s), ${entry.spikes} spike(s) (${entry.spikes_ok} ok, ${entry.spikes_error} error, ${entry.spikes_skipped} skipped)`
        : "no cycles in this window";
      console.log(`            ${entry.id.padEnd(12)} ${entry.enabled ? "" : "(disabled) "}${detail}`);
    }
  }

  const byCatalog = Object.entries(spend.by_catalog).sort((a, b) => b[1].tokens.total - a[1].tokens.total).slice(0, 8);
  if (byCatalog.length) {
    console.log("by catalog:");
    for (const [name, entry] of byCatalog) {
      console.log(`            ${name.padEnd(20)} ${count(entry.runs).padStart(5)} run(s)  ${count(entry.tokens.total).padStart(10)} tokens`);
    }
  }
};

export const run = async (argv) => {
  let from = null;
  let to = null;
  let since = null;
  let mindRef = null;
  let storage = true;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = argv[++i];
    else if (argv[i] === "--to") to = argv[++i];
    else if (argv[i] === "--since") since = parseDuration(argv[++i], "--since");
    else if (argv[i] === "--mind") mindRef = argv[++i];
    else if (argv[i] === "--no-storage") storage = false;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") return usage();
    else fail("unknown flag: " + argv[i]);
  }
  if (since !== null && from) fail("--since and --from say the same thing two ways; pass one");

  // Any registered mind by id or name, or the project this command was run in. Both are
  // wanted: reading one agent's spend from inside another's directory is the normal case
  // once a machine has several.
  const mind = mindRef ? await resolveMind(mindRef) : { root: requireProjectRoot(), name: null, agentId: null };
  const report = await readUsage(mind.root, {
    from: since !== null ? Date.now() - since : from,
    to,
    storage,
  });

  if (json) {
    console.log(JSON.stringify({ ...report, agent_id: mind.agentId, name: mind.name }, null, 2));
    return;
  }
  console.log(`mind:     ${mind.name || report.root}${mind.agentId ? ` (${mind.agentId})` : ""}`);
  describe(report);
};
