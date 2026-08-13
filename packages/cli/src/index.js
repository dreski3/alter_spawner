#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MindError } from "@mind/core";

const CLI_ENTRY = fileURLToPath(import.meta.url);
const CLI_PKG = JSON.parse(readFileSync(path.join(path.dirname(CLI_ENTRY), "..", "package.json"), "utf8"));

const usage = (write = console.log) => {
  write("usage: mind <command> [args]");
  write("");
  write("  init    [--source <path>] [--name <n>] [--force] [--new-identity]");
  write("                                          (scaffold this directory as a mind project)");
  write("  update  [--source <path>]              (re-apply profile-owned files + new catalog entries)");
  write("  spawn   --name? --description? --model? --image <file>* --allow <p> --allow-write <p>");
  write("          --nestable? --web? --timeout? --rm? --verbose?");
  write("          --catalog <name>? --executor <name>? --max-tokens <n>? --fallback-model <m>?");
  write("          --allow-catalog <name>* | --allow-no-catalogs?");
  write("          --prompt-prefix <s>? --prompt-suffix <s>?");
  write("          --bash-allow <pattern>? --bash-only? --text-only?");
  write("          --output-exact <s>? --output-prefix <s>? --output-regex <s>? --output-json?");
  write("          --opencode-provider-file <json>?  <prompt>");
  write("  create  (same flags as spawn; scaffolds a home without running)");
  write("  run     <home-or-id> [--image <file>]* <prompt...>");
  write("  list    (list alter homes + status)");
  write("  tree    (nesting tree)");
  write("  show    <id>          (print result.json)");
  write("  rm      <id>          (delete a home)");
  write("  memory  search <query> [--limit <n>] [--kind <k>]*    (ask the host to search persistent memory)");
  write("  memory  put <content> [--kind <k>] [--tag <t>]*       (ask the host to store a durable record)");
  write("  memory  ask <text>                                     (let the memory assistant decide: remember or recall)");
  write("  memory  stats                                           (inspect persistent-memory storage)");
  write("  memory  migrate --to sqlite                            (copy JSON memory into SQLite/FTS)");
  write("  agents  ls | scan | add <dir> [--workspace] | rm <dir> | where <id|name>");
  write("                                          (the registry of minds this machine knows)");
  write("  oscillation ls | show <id> | run <id> [--force] | add <file|-> | rm <id>");
  write("              | grants | grant <cat> <cap>  (this mind's rhythms)");
  write("  usage   [--since <dur>] [--from <when>] [--to <when>] [--mind <id|name>]");
  write("          [--no-storage] [--json]         (tokens, tool calls and storage for one mind)");
  write("  daemon  [--once] [--interval <dur>] [--dry-run] [--mind <id|name>]");
  write("                                          (tick every mind's due oscillations)");
  write("  catalog list                            (list predefined harnesses)");
  write("  catalog show <name>                     (print a harness manifest.json)");
  write("  catalog save <name> --from <id> | ...spawn flags   (add/update a harness)");
  write("  catalog export <name> --to <dir>        (copy an alter project out, to version or share)");
  write("  catalog import <dir> [--as <name>] [--trust]       (copy one in; grants are dropped unless --trust)");
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
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage();
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(CLI_PKG.version);
    return;
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    if (cmd) {
      console.error(
        `mind: unrecognized command "${cmd}" (argv: ${JSON.stringify(process.argv.slice(2))})`,
      );
      console.error("");
    }
    usage(console.error);
    process.exitCode = 1;
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
