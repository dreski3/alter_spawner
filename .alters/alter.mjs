#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const KIT = path.dirname(SCRIPT_PATH);
const TEMPLATE = path.join(KIT, "_template");
const CONFIG_FILE = path.join(KIT, "config.json");
const UP = path.dirname(KIT);

const TEMPLATE_AGENT = path.join(TEMPLATE, ".opencode", "agents", "alter.md");

const NESTABLE_BASH_RULES = [
  '"*": deny',
  '"node .alters/alter.mjs **": allow',
  '"node .alters/alter.mjs": allow',
  '"node **/.alters/alter.mjs **": allow',
  '"node **/.alters/alter.mjs": allow',
  '"node */.alters/alter.mjs*": allow',
];

const iso = (ms) => new Date(ms).toISOString();
const fail = (msg) => {
  console.error("alter: " + msg);
  process.exit(1);
};
const readConfig = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
};
const normPath = (p) => {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(p);
};
const yq = (s) => JSON.stringify(String(s));

const grantDir = (p) => {
  try {
    if (existsSync(p) && statSync(p).isFile()) return path.dirname(p);
  } catch {}
  return p;
};

const gitInit = (home) => {
  try {
    const r = spawnSync(
      "git",
      ["init", "--quiet"],
      { cwd: home, stdio: "ignore" }
    );
    if (r.status !== 0) {
      spawnSync("git", ["init"], { cwd: home, stdio: "ignore" });
    }
  } catch {}
};

const buildFrontmatter = (o) => {
  const L = [];
  L.push("---");
  L.push(`description: ${yq(o.description || "Single-use sandboxed Alter.")}`);
  L.push("mode: all");
  if (o.model) L.push(`model: ${o.model}`);
  L.push("permission:");
  L.push("  read: allow");
  L.push("  glob: allow");
  L.push("  grep: allow");
  L.push("  skill: allow");
  L.push("  edit:");
  L.push('    "**": allow');
  const readDirs = o.readGrants.map(grantDir);
  const writeDirs = o.writeGrants.map(grantDir);
  for (const d of readDirs) {
    L.push(`    ${yq(d + "/**")}: deny`);
    L.push(`    ${yq(d + "/*")}: deny`);
    L.push(`    ${yq(d)}: deny`);
  }
  for (const d of writeDirs) {
    L.push(`    ${yq(d + "/**")}: allow`);
    L.push(`    ${yq(d + "/*")}: allow`);
    L.push(`    ${yq(d)}: allow`);
  }
  L.push("  write:");
  L.push('    "**": allow');
  if (o.nestable) {
    L.push("  bash:");
    for (const r of NESTABLE_BASH_RULES) L.push("    " + r);
  } else {
    L.push("  bash: deny");
  }
  L.push("  webfetch: deny");
  L.push("  websearch: deny");
  L.push("  task: deny");
  L.push("  todowrite: deny");
  L.push("  question: deny");
  L.push("  external_directory:");
  const grantDirs = [...readDirs, ...writeDirs];
  if (grantDirs.length === 0) {
    L.push('    "**": deny');
  } else {
    L.push('    "**": deny');
    const seen = new Set();
    for (const d of grantDirs) {
      for (const pat of [d, d + "/*", d + "/**"]) {
        if (seen.has(pat)) continue;
        seen.add(pat);
        L.push(`    ${yq(pat)}: allow`);
      }
    }
  }
  L.push("---");
  return L.join("\n");
};

const buildBody = (o) => {
  let tmpl = "";
  try {
    tmpl = readFileSync(TEMPLATE_AGENT, "utf8");
  } catch {
    tmpl = "{{ROLE_BLOCK}}";
  }
  const idx = tmpl.indexOf("\n---\n");
  let body = idx >= 0 ? tmpl.slice(idx + 5) : tmpl;
  const role = o.description && o.description.trim()
    ? `## Your role\n${o.description.trim()}`
    : `## Your role\nYou are a general-purpose Alter. Perform the task you were given as well as you can.`;
  body = body.replace(/\{\{ROLE_BLOCK\}\}/g, role);
  return body.trimStart();
};

const sanitizeName = (n) =>
  String(n).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[-_.]+/, "").slice(0, 64);

const resolveId = (name) => {
  if (!name) {
    const epoch = Math.floor(Date.now() / 1000);
    return `alter_${epoch}_${Math.random().toString(36).slice(2, 6)}`;
  }
  const base = sanitizeName(name);
  if (!base) return resolveId(null);
  if (!existsSync(path.join(KIT, base))) return base;
  return `${base}_${Math.floor(Date.now() / 1000)}`;
};

const scaffold = (o) => {
  const home = path.join(KIT, o.id);
  if (existsSync(home)) fail("home already exists: " + path.relative(UP, home));
  mkdirSync(home, { recursive: true });
  gitInit(home);
  cpSync(TEMPLATE, home, { recursive: true });
  const agentDir = path.join(home, ".opencode", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "alter.md"),
    buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
  );
  writeFileSync(
    path.join(home, "alter.json"),
    JSON.stringify(
      {
        id: o.id,
        name: o.name || null,
        description: o.description || null,
        model: o.model,
        nestable: !!o.nestable,
        depth: o.depth,
        parent_id: process.env.ALTER_ID || null,
        spawned_by: process.env.ALTER_ID || "root",
        read_grants: o.readGrants,
        write_grants: o.writeGrants,
        created_at: iso(Date.now()),
        home: path.relative(UP, home),
      },
      null,
      2
    ) + "\n"
  );
  if (o.nestable) {
    const childKit = path.join(home, ".alters");
    mkdirSync(childKit, { recursive: true });
    for (const item of ["alter.mjs", "_template"]) {
      cpSync(path.join(KIT, item), path.join(childKit, item), { recursive: true });
    }
    const cfg = readConfig();
    writeFileSync(
      path.join(childKit, "config.json"),
      JSON.stringify(
        {
          default_model: o.model,
          max_depth: cfg.max_depth ?? 5,
          run_timeout_ms: cfg.run_timeout_ms ?? 180000,
        },
        null,
        2
      ) + "\n"
    );
  }
  return home;
};

const parseRun = (stdout, exitCode, killed) => {
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 };
  let text = "";
  let sessionID = null;
  let steps = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.type === "step_finish") {
      const tk = obj.part?.tokens || {};
      tokens.input += tk.input || 0;
      tokens.output += tk.output || 0;
      tokens.reasoning += tk.reasoning || 0;
      tokens.cache_read += tk.cache?.read || 0;
      tokens.total += tk.total || 0;
      steps += 1;
    } else if (obj.type === "text") {
      text += obj.part?.text || "";
    }
    if (!sessionID && obj.sessionID) sessionID = obj.sessionID;
  }
  return { tokens, text, sessionID, steps, exitCode, killed, ok: exitCode === 0 && !killed };
};

const runAgent = (home, prompt, timeout, depth, alterId) =>
  new Promise((resolve) => {
    const child = spawn(
      "opencode",
      ["run", "--agent", "alter", "--dir", home, "--format", "json", prompt],
      {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ALTER_DEPTH: String(depth),
          ALTER_ID: alterId || "",
        },
      }
    );
    let stdout = "";
    let settled = false;
    let timer;
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      process.stderr.write("(alter stderr) " + d.toString());
    });
    const finish = (exitCode, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseRun(stdout, exitCode, killed));
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(-1, true);
    }, timeout);
    child.on("error", (e) => {
      process.stderr.write("alter spawn error: " + e.message + "\n");
      finish(-2, false);
    });
    child.on("close", (code) => finish(code, false));
  });

const writeResult = (home, o, res, startedAt, endedAt, durationMs) => {
  const result = {
    id: o.id,
    ok: res.ok,
    exit_code: res.exitCode,
    killed: res.killed,
    text: res.text,
    tokens: res.tokens,
    steps: res.steps,
    session_id: res.sessionID,
    model: o.model,
    depth: o.depth,
    home: path.relative(UP, home),
    spawned_by: o.spawned_by,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
  };
  writeFileSync(path.join(home, "result.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(home, "result.md"), (res.text || "(no output)\n") + "\n");
  return result;
};

const printResult = (o, res, result, verbose) => {
  if (verbose) {
    console.error(
      `alter ${o.id}: ok=${res.ok} depth=${o.depth} model=${o.model} steps=${res.steps} tokens=${res.tokens.total} ms=${result.duration_ms}`
    );
    console.error(`home: ${result.home}`);
  }
  const out = res.text || "";
  process.stdout.write(out);
  if (out && !out.endsWith("\n")) process.stdout.write("\n");
};

const parseSpawnArgs = (argv) => {
  const o = {
    name: null,
    description: null,
    model: null,
    prompt: null,
    readGrants: [],
    writeGrants: [],
    nestable: false,
    timeout: null,
    rm: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") o.name = argv[++i];
    else if (a === "--description") o.description = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--allow") o.readGrants.push(normPath(argv[++i]));
    else if (a === "--allow-write") o.writeGrants.push(normPath(argv[++i]));
    else if (a === "--nestable") o.nestable = true;
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--rm") o.rm = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--prompt") o.prompt = argv[++i];
    else if (a.startsWith("--")) fail("unknown flag: " + a);
    else o.prompt = o.prompt ? o.prompt + " " + a : a;
  }
  if (!o.prompt) fail("spawn requires a prompt (positional or --prompt \"...\").");
  return o;
};

const resolveEffectiveModel = (o) =>
  o.model || process.env.ALTER_MODEL || readConfig().default_model || "zai-coding-plan/glm-5-turbo";

const cmdSpawn = async (argv, { createOnly = false } = {}) => {
  const o = parseSpawnArgs(argv);
  const cfg = readConfig();
  const incoming =
    process.env.ALTER_DEPTH !== undefined ? Number(process.env.ALTER_DEPTH) : -1;
  const depth = incoming + 1;
  const maxDepth = cfg.max_depth ?? 5;
  if (depth >= maxDepth) {
    fail(
      `max nesting depth (${maxDepth}) reached; refusing to spawn at depth ${depth}.`
    );
  }
  o.depth = depth;
  o.id = resolveId(o.name);
  o.name = o.name || o.id;
  o.model = resolveEffectiveModel(o);
  o.spawned_by = process.env.ALTER_ID || "root";
  const home = scaffold(o);
  if (createOnly) {
    console.log(home);
    console.error(`created (not run): ${path.relative(UP, home)}  depth=${depth} model=${o.model}`);
    return;
  }
  const timeout = o.timeout ?? cfg.run_timeout_ms ?? 180000;
  const startedAt = iso(Date.now());
  const startMs = Date.now();
  const res = await runAgent(home, o.prompt, timeout, depth, o.id);
  const endedAt = iso(Date.now());
  const result = writeResult(home, o, res, startedAt, endedAt, Date.now() - startMs);
  printResult(o, res, result, o.verbose);
  if (o.rm) rmSync(home, { recursive: true, force: true });
  if (!res.ok) process.exitCode = 1;
};

const readAlterJson = (home) => {
  try {
    return JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
  } catch {
    return {};
  }
};

const resolveHome = (arg) => {
  if (!arg) fail("missing <home-or-id>.");
  const asId = path.join(KIT, arg);
  if (existsSync(asId) && existsSync(path.join(asId, "alter.json"))) return asId;
  const abs = path.resolve(arg);
  if (existsSync(abs)) return abs;
  fail("home not found: " + arg);
};

const cmdRun = async (argv) => {
  const home = resolveHome(argv[0]);
  const prompt = argv.slice(1).join(" ").trim();
  if (!prompt) fail("usage: alter.mjs run <home-or-id> <prompt...>");
  const aj = readAlterJson(home);
  const cfg = readConfig();
  const depth = aj.depth != null ? aj.depth : 0;
  const timeout = cfg.run_timeout_ms ?? 180000;
  const startedAt = iso(Date.now());
  const startMs = Date.now();
  const res = await runAgent(home, prompt, timeout, depth, aj.id || path.basename(home));
  const endedAt = iso(Date.now());
  const o = {
    id: aj.id || path.basename(home),
    model: aj.model || readConfig().default_model,
    depth,
    spawned_by: aj.parent_id || process.env.ALTER_ID || "root",
  };
  const result = writeResult(home, o, res, startedAt, endedAt, Date.now() - startMs);
  printResult(o, res, result, false);
  if (!res.ok) process.exitCode = 1;
};

const listHomes = (dir = KIT) => {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => !n.startsWith(".") && n !== "_template")
    .map((n) => path.join(dir, n))
    .filter((p) => existsSync(path.join(p, "alter.json")))
    .map((p) => ({ id: path.basename(p), path: p }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

const cmdList = () => {
  const homes = listHomes();
  if (!homes.length) {
    console.log("(no alters in " + path.relative(UP, KIT) + "/)");
    return;
  }
  for (const h of homes) {
    const aj = readAlterJson(h.path);
    const done = existsSync(path.join(h.path, "result.json"));
    const state = done ? "done" : "pending";
    const nest = aj.nestable ? "+nest" : "";
    console.log(
      `${h.id}\t${state}${nest}\td${aj.depth ?? 0}\t${path.relative(UP, h.path)}`
    );
  }
};

const cmdTree = (dir = KIT, prefix = "", isLast = true, label = path.basename(KIT) + "/") => {
  if (dir === KIT) {
    console.error(label);
  } else {
    console.error(prefix + (isLast ? "└─ " : "├─ ") + path.basename(dir) + "/");
  }
  const homes = listHomes(dir);
  homes.forEach((h, i) => {
    const last = i === homes.length - 1;
    const aj = readAlterJson(h.path);
    const done = existsSync(path.join(h.path, "result.json"));
    const branch = dir === KIT ? prefix : prefix + (isLast ? "   " : "│  ");
    console.error(branch + (last ? "└─ " : "├─ ") + h.id + (aj.nestable ? " (nestable)" : "") + (done ? "" : " [pending]"));
    const childKit = path.join(h.path, ".alters");
    if (existsSync(childKit)) {
      cmdTree(childKit, branch + (last ? "   " : "│  "), true, "");
    }
  });
};

const cmdShow = (argv) => {
  const home = resolveHome(argv[0]);
  const resultFile = path.join(home, "result.json");
  if (existsSync(resultFile)) {
    process.stdout.write(readFileSync(resultFile, "utf8"));
  } else {
    console.log("(no result.json yet; showing alter.json)");
    process.stdout.write(readFileSync(path.join(home, "alter.json"), "utf8"));
  }
};

const cmdRm = (argv) => {
  let home = argv[0];
  if (!home) fail("usage: alter.mjs rm <id-or-path>");
  const asId = path.join(KIT, home);
  home = existsSync(asId) ? asId : path.resolve(home);
  if (!existsSync(home)) fail("home not found: " + home);
  rmSync(home, { recursive: true, force: true });
  console.log("removed: " + path.relative(UP, home));
};

const usage = () => {
  console.error("usage: alter.mjs <command> [args]");
  console.error("");
  console.error("  spawn   --name? --description? --model? --allow <p> --allow-write <p>");
  console.error("          --nestable? --timeout? --rm? --verbose?  <prompt>");
  console.error("  create  (same flags as spawn; scaffolds a home without running)");
  console.error("  run     <home-or-id> <prompt...>");
  console.error("  list    (list alter homes + status)");
  console.error("  tree    (nesting tree)");
  console.error("  show    <id>          (print result.json)");
  console.error("  rm      <id>          (delete a home)");
};

const cmd = process.argv[2];
const rest = process.argv.slice(3);
if (cmd === "spawn") cmdSpawn(rest);
else if (cmd === "create") cmdSpawn(rest, { createOnly: true });
else if (cmd === "run") cmdRun(rest);
else if (cmd === "list" || cmd === "ls") cmdList();
else if (cmd === "tree") cmdTree();
else if (cmd === "show") cmdShow(rest);
else if (cmd === "rm") cmdRm(rest);
else usage();
