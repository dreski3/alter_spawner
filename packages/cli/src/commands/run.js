import { requireProjectRoot, runExistingAlter, fail, normPath } from "@mind/core";

export const run = async (argv, ctx) => {
  const home = argv[0];
  const images = [];
  const promptParts = [];
  let parseFlags = true;
  for (let i = 1; i < argv.length; i++) {
    if (parseFlags && argv[i] === "--") {
      parseFlags = false;
    } else if (parseFlags && argv[i] === "--image") {
      if (!argv[i + 1]) fail("--image requires a file path.");
      images.push(normPath(argv[++i]));
    } else {
      promptParts.push(argv[i]);
    }
  }
  const prompt = promptParts.join(" ").trim();
  if (!home || !prompt) fail("usage: mind run <home-or-id> [--image <file>]* <prompt...>");
  const root = requireProjectRoot();
  const { res, result } = await runExistingAlter(root, home, prompt, { images, mindBinPath: ctx.cliEntry });
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
