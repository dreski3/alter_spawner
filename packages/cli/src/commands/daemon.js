import { fail, formatDuration, parseDuration, runDaemon, runDaemonTick } from "@mind/core";

const usage = () => {
  console.error("usage: mind daemon [--once] [--interval <dur>] [--dry-run] [--force] [--mind <id|name>] [--json]");
  console.error("");
  console.error("  Ticks every registered mind's due oscillations. --once runs a single pass and exits,");
  console.error("  which is the form to put under launchd/cron; without it, it loops until interrupted.");
};

const describeTick = (tick) => {
  for (const mind of tick.minds) {
    if (mind.error) {
      console.log(`${mind.name}\terror: ${mind.error}`);
      continue;
    }
    if (!mind.oscillations.length) {
      console.log(`${mind.name}\t(no oscillations)`);
      continue;
    }
    for (const entry of mind.oscillations) {
      const detail = entry.action === "not-due"
        ? `due in ${formatDuration(entry.dueInMs)}`
        : entry.skipped
          ? `skipped: ${entry.skipped}`
          : (entry.spikes || []).map((spike) => `${spike.id}=${spike.state}`).join(" ");
      console.log(`${mind.name}\t${entry.id}\t${entry.action}${detail ? `\t${detail}` : ""}`);
    }
  }
};

export const run = async (argv, ctx) => {
  let once = false;
  let dryRun = false;
  let force = false;
  let json = false;
  let only = null;
  let intervalMs = 60_000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--once") once = true;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--force") force = true;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--mind") only = argv[++i];
    else if (argv[i] === "--interval") intervalMs = parseDuration(argv[++i], "--interval");
    else if (argv[i] === "--help" || argv[i] === "-h") return usage();
    else fail("unknown flag: " + argv[i]);
  }
  if (intervalMs < 1000) fail("--interval must be at least 1s");

  const options = {
    mindBinPath: ctx.cliEntry,
    dryRun,
    force,
    only,
    onLog: (line) => {
      if (json) return;
      const where = [line.mind, line.oscillation, line.spike].filter(Boolean).join("/");
      console.error(`  ${line.level}: ${where}${line.message ? ` ${line.message}` : ""}` +
        `${line.skipped ? ` skipped (${line.skipped})` : ""}${line.error ? ` — ${line.error}` : ""}`);
    },
  };

  if (once) {
    const tick = await runDaemonTick(options);
    if (json) console.log(JSON.stringify(tick, null, 2));
    else describeTick(tick);
    return;
  }

  // A long-lived daemon has to stop cleanly: the abort signal reaches the in-flight tick,
  // so an interrupted cycle releases its refractory lock instead of leaving one behind for
  // the stale-holder check to reclaim later.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.error(`mind daemon: ticking every ${formatDuration(intervalMs)} (ctrl-c to stop)`);
  const { ticks } = await runDaemon({
    ...options,
    intervalMs,
    signal: controller.signal,
    onTick: (tick) => {
      if (json) console.log(JSON.stringify(tick));
      else if (tick.fired || tick.minds.some((mind) => mind.error)) describeTick(tick);
    },
  });
  console.error(`mind daemon: stopped after ${ticks} tick(s)`);
};
