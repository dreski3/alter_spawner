import { readFileSync } from "node:fs";
import { createSpawnOptions } from "./spawn-spec.js";
import { normPath } from "./util.js";

export const parseSpawnArgs = (argv) => {
  const o = createSpawnOptions();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") o.name = argv[++i];
    else if (a === "--description") o.description = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--allow") o.readGrants.push(normPath(argv[++i]));
    else if (a === "--allow-write") o.writeGrants.push(normPath(argv[++i]));
    else if (a === "--bash-allow") o.bashAllow.push(argv[++i]);
    else if (a === "--bash-only") o.bashOnly = true;
    else if (a === "--nestable") o.nestable = true;
    else if (a === "--web") o.webAccess = true;
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--rm") o.rm = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--prompt") o.prompt = argv[++i];
    else if (a === "--catalog") o.catalog = argv[++i];
    else if (a === "--max-tokens") o.maxTokens = Number(argv[++i]);
    else if (a === "--fallback-model") o.fallbackModel = argv[++i];
    else if (a === "--prompt-prefix") o.promptPrefix = argv[++i];
    else if (a === "--prompt-suffix") o.promptSuffix = argv[++i];
    else if (a === "--output-exact") o.outputContract = { type: "exact", value: argv[++i] };
    else if (a === "--output-prefix") o.outputContract = { type: "prefix", value: argv[++i] };
    else if (a === "--output-regex") o.outputContract = { type: "regex", pattern: argv[++i] };
    else if (a === "--output-json") o.outputContract = { type: "json" };
    else if (a === "--opencode-provider-file") {
      const file = normPath(argv[++i]);
      o.opencodeProvider = JSON.parse(readFileSync(file, "utf8"));
    }
    else if (a.startsWith("--")) throw new Error("unknown flag: " + a);
    else o.prompt = o.prompt ? o.prompt + " " + a : a;
  }
  return o;
};
