import { requireProjectRoot, spawnAlter, fail } from "@mind/core";
import path from "node:path";
import { parseSpawnArgs } from "../parseArgs.js";

export const run = async (argv, ctx, { createOnly = false } = {}) => {
  const o = parseSpawnArgs(argv);
  if (!o.prompt) fail('spawn requires a prompt (positional or --prompt "...").');
  o.mindBinPath = ctx.cliEntry;
  const root = requireProjectRoot();
  const { home, created, result, res } = await spawnAlter(root, o, { createOnly });
  if (created) {
    console.log(home);
    console.error(`created (not run): ${path.relative(root, home)}`);
    return;
  }
  if (o.verbose) {
    console.error(
      `alter ${o.id}: ok=${res.ok} depth=${o.depth} model=${o.model} steps=${res.steps} tokens=${res.tokens.total} ms=${result.duration_ms}`
    );
    console.error(`home: ${result.home}`);
  }
  const out = res.text || "";
  process.stdout.write(out);
  if (out && !out.endsWith("\n")) process.stdout.write("\n");
  // Without this the empty-output case is a bare exit 1 and no output at all,
  // which reads like a crash rather than "the model returned nothing".
  if (res.empty_output) {
    const n = result.attempts?.length ?? 1;
    console.error(
      `alter ${o.id}: returned no final message after ${n} attempt${n === 1 ? "" : "s"} ` +
        `(empty_output; model=${o.model}) — see ${result.home}/result.json`
    );
  }
  if (!res.ok) process.exitCode = 1;
};
