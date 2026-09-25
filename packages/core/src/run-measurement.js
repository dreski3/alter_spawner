import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { writeJsonAtomic } from "./persistence.js";

export const measureRunCall = async (root, kind, onEvent, execute, finalize = null) => {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let home = null;
  try {
    const output = await execute((value) => { home = value; });
    if (finalize) return finalize(output, performance.now() - started, startedAt);
    if (output?.result && output?.home) {
      const timing = output.result.timing || {};
      const duration = performance.now() - started;
      output.result.timing = {
        ...timing,
        pre_persistence_duration_ms: timing.wall_duration_ms ?? null,
        wall_started_at: startedAt,
        wall_ended_at: new Date().toISOString(),
        wall_duration_ms: duration,
        other_ms: Math.max(0, duration - (timing.planning_ms || 0) - (timing.admission_ms || 0) -
          (timing.scaffold_ms || 0) - (timing.execution_ms || 0)),
      };
      if (existsSync(output.home)) writeJsonAtomic(path.join(output.home, "result.json"), output.result);
    }
    return output;
  } catch (error) {
    const relativeHome = home ? path.relative(root, home) : null;
    const measurement = {
      kind,
      status: "failed",
      phase: home ? "after_home" : "before_home",
      wall_started_at: startedAt,
      wall_ended_at: new Date().toISOString(),
      wall_duration_ms: performance.now() - started,
      ...(relativeHome && relativeHome !== ".." && !relativeHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeHome)
        ? { home: relativeHome } : {}),
    };
    const dir = path.join(root, ".alters", "measurements");
    if (existsSync(path.join(root, ".alters"))) {
      try {
        mkdirSync(dir, { recursive: true });
        writeJsonAtomic(path.join(dir, `${Date.now()}-${randomUUID()}.json`), measurement);
      } catch {}
    }
    try { error.measurement = measurement; } catch {}
    try { onEvent?.({ type: "run.failed", measurement }); } catch {}
    throw error;
  }
};
