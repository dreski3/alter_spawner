import { requireProjectRoot, runExistingAlter, fail } from "@mind/core";

export const run = async (argv, ctx) => {
  const home = argv[0];
  const prompt = argv.slice(1).join(" ").trim();
  if (!home || !prompt) fail("usage: mind run <home-or-id> <prompt...>");
  const root = requireProjectRoot();
  const { res } = await runExistingAlter(root, home, prompt, { mindBinPath: ctx.cliEntry });
  const out = res.text || "";
  process.stdout.write(out);
  if (out && !out.endsWith("\n")) process.stdout.write("\n");
  if (!res.ok) process.exitCode = 1;
};
