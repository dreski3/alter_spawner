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
  console.error("  init    [--source <path>] [--name <n>] [--force] [--new-identity]");
  console.error("                                          (scaffold this directory as a mind project)");
  console.error("  update  [--source <path>]              (re-apply profile-owned files + new catalog entries)");
  console.error("  spawn   --name? --description? --model? --allow <p> --allow-write <p>");
  console.error("          --nestable? --web? --timeout? --rm? --verbose?");
  console.error("          --catalog <name>? --executor <name>? --max-tokens <n>? --fallback-model <m>?");
  console.error("          --allow-catalog <name>* | --allow-no-catalogs?");
  console.error("          --prompt-prefix <s>? --prompt-suffix <s>?");
  console.error("          --bash-allow <pattern>? --bash-only? --text-only?");
  console.error("          --output-exact <s>? --output-prefix <s>? --output-regex <s>? --output-json?");
  console.error("          --opencode-provider-file <json>?  <prompt>");
  console.error("  create  (same flags as spawn; scaffolds a home without running)");
  console.error("  run     <home-or-id> <prompt...>");
  console.error("  list    (list alter homes + status)");
  console.error("  tree    (nesting tree)");
  console.error("  show    <id>          (print result.json)");
  console.error("  rm      <id>          (delete a home)");
  console.error("  memory  search <query> [--limit <n>] [--kind <k>]*    (ask the host to search persistent memory)");
  console.error("  memory  put <content> [--kind <k>] [--tag <t>]*       (ask the host to store a durable record)");
  console.error("  memory  ask <text>                                     (let the memory assistant decide: remember or recall)");
  console.error("  memory  stats                                           (inspect persistent-memory storage)");
  console.error("  memory  migrate --to sqlite                            (copy JSON memory into SQLite/FTS)");
  console.error("  agents  ls | scan | add <dir> [--workspace] | rm <dir> | where <id|name>");
  console.error("                                          (the registry of minds this machine knows)");
  console.error("  oscillation ls | show <id> | run <id> [--force] | add <file|-> | rm <id>");
  console.error("              | grants | grant <cat> <cap>  (this mind's rhythms)");
  console.error("  usage   [--since <dur>] [--from <when>] [--to <when>] [--mind <id|name>]");
  console.error("          [--no-storage] [--json]         (tokens, tool calls and storage for one mind)");
  console.error("  daemon  [--once] [--interval <dur>] [--dry-run] [--mind <id|name>]");
  console.error("                                          (tick every mind's due oscillations)");
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
  agents: () => import("./commands/agents.js"),
  oscillation: () => import("./commands/oscillation.js"),
  daemon: () => import("./commands/daemon.js"),
  usage: () => import("./commands/usage.js"),
  catalog: () => import("./commands/catalog.js"),
  memory: () => import("./commands/memory.js"),
};

const main = async () => {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  const loader = COMMANDS[cmd];
  if (!loader) {
    if (cmd) {
      console.error(
        `mind: unrecognized command "${cmd}" (argv: ${JSON.stringify(process.argv.slice(2))})`,
      );
      console.error("");
    }
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
