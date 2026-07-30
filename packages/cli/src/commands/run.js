import { requireProjectRoot, runExistingAlter, fail } from "@mind/core";

export const run = async (argv, ctx) => {
  const home = argv[0];
  const prompt = argv.slice(1).join(" ").trim();
  if (!home || !prompt) fail("usage: mind run <home-or-id> <prompt...>");
  const root = requireProjectRoot();
  const { res, result } = await runExistingAlter(root, home, prompt, { mindBinPath: ctx.cliEntry });
  const out = res.text || "";
  process.stdout.write(out);
  if (out && !out.endsWith("\n")) process.stdout.write("\n");
  if (res.empty_output) {
    const n = result.attempts?.length ?? 1;
    console.error(
      `alter ${result.id}: returned no final message after ${n} attempt${n === 1 ? "" : "s"} ` +
        `(empty_output; model=${result.model}) — see ${result.home}/result.json`
    );
  }
  if (!res.ok) process.exitCode = 1;
};
