#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MindError } from "@mind/core";

const CLI_ENTRY = fileURLToPath(import.meta.url);
const CLI_PKG = JSON.parse(readFileSync(path.join(path.dirname(CLI_ENTRY), "..", "package.json"), "utf8"));

const usage = () => {
  console.error("usage: mind <command> [args]");
  console.error("");
  console.error("  init    [--source <path>] [--force]   (scaffold this directory as a mind project)");
  console.error("  update  [--source <path>]              (re-apply profile-owned files + new catalog entries)");
  console.error("  spawn   --name? --description? --model? --allow <p> --allow-write <p>");
  console.error("          --nestable? --web? --timeout? --rm? --verbose?");
  console.error("          --catalog <name>? --max-tokens <n>? --fallback-model <m>?");
  console.error("          --prompt-prefix <s>? --prompt-suffix <s>?  <prompt>");
  console.error("  create  (same flags as spawn; scaffolds a home without running)");
  console.error("  run     <home-or-id> <prompt...>");
  console.error("  list    (list alter homes + status)");
  console.error("  tree    (nesting tree)");
  console.error("  show    <id>          (print result.json)");
  console.error("  rm      <id>          (delete a home)");
  console.error("  catalog list                            (list predefined harnesses)");
  console.error("  catalog show <name>                     (print a harness manifest.json)");
  console.error("  catalog save <name> --from <id> | ...spawn flags   (add/update a harness)");
};

const COMMANDS = {
  init: () => import("./commands/init.js"),
  update: () => import("./commands/update.js"),
  spawn: () => import("./commands/spawn.js"),
  create: () => import("./commands/create.js"),
  run: () => import("./commands/run.js"),
  list: () => import("./commands/list.js"),
  ls: () => import("./commands/list.js"),
  tree: () => import("./commands/tree.js"),
  show: () => import("./commands/show.js"),
  rm: () => import("./commands/rm.js"),
  catalog: () => import("./commands/catalog.js"),
};

const main = async () => {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  const loader = COMMANDS[cmd];
  if (!loader) {
    usage();
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  const mod = await loader();
  const ctx = { cliEntry: CLI_ENTRY, cliVersion: CLI_PKG.version };
  await mod.run(rest, ctx);
};

main().catch((e) => {
  if (e instanceof MindError) {
    console.error("mind: " + e.message);
  } else {
    console.error("mind: " + (e?.message || e));
  }
  process.exitCode = 1;
});
