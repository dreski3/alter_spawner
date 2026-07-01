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
  L.push(o.webAccess ? "  webfetch: allow" : "  webfetch: deny");
  L.push(o.webAccess ? "  websearch: allow" : "  websearch: deny");
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
  const overridePath =
    o.catalogEntryDir && o.catalogAgentsOverride
      ? path.join(o.catalogEntryDir, o.catalogAgentsOverride)
      : null;
  try {
    tmpl = readFileSync(overridePath || TEMPLATE_AGENT, "utf8");
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

const catalogDirPath = () => path.join(KIT, readConfig().catalog_dir || "catalog");

const validateManifest = (m, name) => {
  if (!m || typeof m !== "object") fail(`catalog entry "${name}": manifest.json is not an object.`);
  if (!m.name) fail(`catalog entry "${name}": manifest.json missing "name".`);
  if (m.name !== name) fail(`catalog entry "${name}": manifest.json "name" (${m.name}) does not match folder name.`);
  if (!m.description) fail(`catalog entry "${name}": manifest.json missing "description".`);
  if (m.max_tokens != null && !(Number.isInteger(m.max_tokens) && m.max_tokens > 0)) {
    fail(`catalog entry "${name}": max_tokens must be a positive integer or null.`);
  }
  if (m.nestable != null && typeof m.nestable !== "boolean") {
    fail(`catalog entry "${name}": nestable must be a boolean.`);
  }
  if (m.web != null && typeof m.web !== "boolean") {
    fail(`catalog entry "${name}": web must be a boolean.`);
  }
  for (const key of ["read_grants", "write_grants"]) {
    if (m[key] != null && !Array.isArray(m[key])) fail(`catalog entry "${name}": ${key} must be an array.`);
  }
};

// Resolution seam: "local" is the only implemented source today. A future "mcp" source
// would return the same { dir, manifest } shape so callers never branch on source.type.
const resolveCatalogEntry = (name) => {
  const dir = path.join(catalogDirPath(), sanitizeName(name));
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`catalog entry not found: ${name}`);
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`catalog entry "${name}": manifest.json is not valid JSON (${e.message}).`);
  }
  validateManifest(m, name);
  if (m.source && m.source.type === "mcp") {
    fail(`catalog entry "${name}" is MCP-backed; MCP resolution is not yet implemented.`);
  }
  return { dir, manifest: m };
};

// Precedence: any flag the caller explicitly passed wins; anything left at its
// parse-time default (null / empty array / false) is filled from the catalog manifest.
const applyCatalog = (o, entry) => {
  const m = entry.manifest;
  if (o.description == null) o.description = m.description;
  if (o.model == null) o.model = m.model || null;
  if (o.fallbackModel == null) o.fallbackModel = m.fallback_model || null;
  if (o.maxTokens == null) o.maxTokens = m.max_tokens ?? null;
  if (!o.nestable) o.nestable = !!m.nestable;
  if (!o.webAccess) o.webAccess = !!m.web;
  if (o.timeout == null) o.timeout = m.timeout_ms ?? null;
  if (o.readGrants.length === 0) o.readGrants = (m.read_grants || []).map(normPath);
  if (o.writeGrants.length === 0) o.writeGrants = (m.write_grants || []).map(normPath);
  o.promptPrefix = o.promptPrefix ?? m.prompt_prefix ?? null;
  o.promptSuffix = o.promptSuffix ?? m.prompt_suffix ?? null;
  o.catalogEntryDir = entry.dir;
  o.catalogAgentsOverride = m.agents_md_override || null;
  o.catalogSkillsDir = m.skills_dir || null;
  o.catalogName = m.name;
};

const scaffold = (o) => {
  const home = path.join(KIT, o.id);
  if (existsSync(home)) fail("home already exists: " + path.relative(UP, home));
  mkdirSync(home, { recursive: true });
  gitInit(home);
  cpSync(TEMPLATE, home, { recursive: true });
  if (o.catalogEntryDir && o.catalogSkillsDir) {
    const src = path.join(o.catalogEntryDir, o.catalogSkillsDir);
    if (existsSync(src)) {
      const dest = path.join(home, ".opencode", "skills");
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
  }
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
        web: !!o.webAccess,
        depth: o.depth,
        parent_id: process.env.ALTER_ID || null,
        spawned_by: process.env.ALTER_ID || "root",
        read_grants: o.readGrants,
        write_grants: o.writeGrants,
        catalog: o.catalogName || null,
        max_tokens: o.maxTokens ?? null,
        fallback_model: o.fallbackModel || null,
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
    const catalogDirName = cfg.catalog_dir || "catalog";
    const catalogSrc = path.join(KIT, catalogDirName);
    if (existsSync(catalogSrc)) {
      cpSync(catalogSrc, path.join(childKit, catalogDirName), { recursive: true });
    }
    writeFileSync(
      path.join(childKit, "config.json"),
      JSON.stringify(
        {
          default_model: o.model,
          max_depth: cfg.max_depth ?? 5,
          run_timeout_ms: cfg.run_timeout_ms ?? 180000,
          catalog_dir: catalogDirName,
          default_fallback_model: o.fallbackModel || cfg.default_fallback_model || null,
          retry: cfg.retry || { same_harness_retries: 1, fallback_retries: 1 },
        },
        null,
        2
      ) + "\n"
    );
  }
  return home;
};

const parseLine = (line, acc) => {
  const t = line.trim();
  if (!t) return;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    return;
  }
  if (obj.type === "step_finish") {
    const tk = obj.part?.tokens || {};
    acc.tokens.input += tk.input || 0;
    acc.tokens.output += tk.output || 0;
    acc.tokens.reasoning += tk.reasoning || 0;
    acc.tokens.cache_read += tk.cache?.read || 0;
    acc.tokens.total += tk.total || 0;
    acc.steps += 1;
  } else if (obj.type === "text") {
    acc.text += obj.part?.text || "";
  }
  if (!acc.sessionID && obj.sessionID) acc.sessionID = obj.sessionID;
};

const newAcc = () => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
  text: "",
  sessionID: null,
  steps: 0,
});

// Token-budget enforcement kills the child as soon as usage becomes visible on stdout.
// Whether that is genuinely mid-run or only once opencode has already finished and flushed
// everything at once depends on opencode's own buffering for --format json, which this tool
// does not control. In the worst case, enforcement is equivalent to "reject after the fact":
// the run has already spent its tokens, and the only effect is result.json recording
// ok:false, budget_exceeded:true with no further retries proceeding.
const runAgent = (home, prompt, timeout, depth, alterId, maxTokens) =>
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
    let buf = "";
    const acc = newAcc();
    let settled = false;
    let timer;
    let budgetExceeded = false;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        parseLine(line, acc);
        if (!budgetExceeded && maxTokens && acc.tokens.total > maxTokens) {
          budgetExceeded = true;
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
    });
    child.stderr.on("data", (d) => {
      process.stderr.write("(alter stderr) " + d.toString());
    });
    const finish = (exitCode, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf.trim()) parseLine(buf, acc);
      resolve({
        tokens: acc.tokens,
        text: acc.text,
        sessionID: acc.sessionID,
        steps: acc.steps,
        exitCode,
        killed,
        ok: exitCode === 0 && !killed && !budgetExceeded,
        budget_exceeded: budgetExceeded,
      });
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
    child.on("close", (code) => finish(code, budgetExceeded));
  });

const writeResult = (home, o, res, startedAt, endedAt, durationMs, attempts) => {
  const result = {
    id: o.id,
    ok: res.ok,
    exit_code: res.exitCode,
    killed: res.killed,
    budget_exceeded: res.budget_exceeded || false,
    max_tokens: o.maxTokens ?? null,
    text: res.text,
    tokens: res.tokens,
    steps: res.steps,
    session_id: res.sessionID,
    model: o.model,
    catalog: o.catalogName || null,
    depth: o.depth,
    home: path.relative(UP, home),
    spawned_by: o.spawned_by,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    attempts: attempts || null,
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
    catalog: null,
    maxTokens: null,
    fallbackModel: null,
    promptPrefix: null,
    promptSuffix: null,
    webAccess: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") o.name = argv[++i];
    else if (a === "--description") o.description = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--allow") o.readGrants.push(normPath(argv[++i]));
    else if (a === "--allow-write") o.writeGrants.push(normPath(argv[++i]));
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
    else if (a.startsWith("--")) fail("unknown flag: " + a);
    else o.prompt = o.prompt ? o.prompt + " " + a : a;
  }
  if (!o.prompt) fail("spawn requires a prompt (positional or --prompt \"...\").");
  return o;
};

const resolveEffectiveModel = (o) =>
  o.model || process.env.ALTER_MODEL || readConfig().default_model || "zai-coding-plan/glm-5-turbo";

// Attempt plan: initial run, then `same_harness_retries` retries on the same model, then
// `fallback_retries` retries on an escalated/fallback model (if one is available). A catalog
// entry without a fallback_model gets no fallback tier — we do not guess one for named harnesses.
const buildAttemptPlan = (o, cfg) => {
  const sameRetries = cfg.retry?.same_harness_retries ?? 1;
  const fallbackRetries = cfg.retry?.fallback_retries ?? 1;
  const fallbackModel =
    o.fallbackModel ||
    (o.catalogName ? null : cfg.default_fallback_model || process.env.ALTER_MODEL || null);
  const plan = [{ model: o.model, reason: "initial" }];
  for (let i = 0; i < sameRetries; i++) plan.push({ model: o.model, reason: "retry_same_model" });
  if (fallbackModel && fallbackModel !== o.model) {
    for (let i = 0; i < fallbackRetries; i++) plan.push({ model: fallbackModel, reason: "retry_fallback_model" });
  }
  return plan;
};

// Runs the attempt plan against an existing, already-scaffolded home. `o` must already carry
// description/readGrants/writeGrants/nestable (needed to regenerate alter.md on a model swap,
// since the model is baked into that file's frontmatter rather than passed to `opencode run`).
const runWithRetries = async (o, cfg, home, prompt, timeout, depth) => {
  const plan = buildAttemptPlan(o, cfg);
  const attempts = [];
  let res;
  for (let i = 0; i < plan.length; i++) {
    const attemptModel = plan[i].model;
    if (i > 0 && attemptModel !== plan[i - 1].model) {
      o.model = attemptModel;
      writeFileSync(
        path.join(home, ".opencode", "agents", "alter.md"),
        buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
      );
    }
    const startedAt = iso(Date.now());
    const startMs = Date.now();
    res = await runAgent(home, prompt, timeout, depth, o.id, o.maxTokens);
    const endedAt = iso(Date.now());
    attempts.push({
      attempt: i + 1,
      model: attemptModel,
      reason: plan[i].reason,
      ok: res.ok,
      exit_code: res.exitCode,
      killed: res.killed,
      budget_exceeded: res.budget_exceeded || false,
      tokens: res.tokens,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Date.now() - startMs,
    });
    o.model = attemptModel;
    // A budget overrun is terminal: retrying under the same fixed cap would deterministically
    // fail again regardless of model, so it doesn't advance to the fallback tier.
    if (res.ok || res.budget_exceeded) break;
  }
  return { res, attempts };
};

const cmdSpawn = async (argv, { createOnly = false } = {}) => {
  const o = parseSpawnArgs(argv);
  if (o.catalog) applyCatalog(o, resolveCatalogEntry(o.catalog));
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
  const effectivePrompt = [o.promptPrefix, o.prompt, o.promptSuffix].filter(Boolean).join("\n\n");
  const { res, attempts } = await runWithRetries(o, cfg, home, effectivePrompt, timeout, depth);
  const startedAt = attempts[0].started_at;
  const endedAt = attempts[attempts.length - 1].ended_at;
  const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
  const result = writeResult(home, o, res, startedAt, endedAt, totalDuration, attempts);
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
  const o = {
    id: aj.id || path.basename(home),
    name: aj.name || null,
    description: aj.description || null,
    model: aj.model || readConfig().default_model,
    readGrants: aj.read_grants || [],
    writeGrants: aj.write_grants || [],
    nestable: !!aj.nestable,
    webAccess: !!aj.web,
    maxTokens: aj.max_tokens ?? null,
    fallbackModel: aj.fallback_model || null,
    catalogName: aj.catalog || null,
    depth,
    spawned_by: aj.parent_id || process.env.ALTER_ID || "root",
  };
  const { res, attempts } = await runWithRetries(o, cfg, home, prompt, timeout, depth);
  const startedAt = attempts[0].started_at;
  const endedAt = attempts[attempts.length - 1].ended_at;
  const totalDuration = attempts.reduce((s, a) => s + a.duration_ms, 0);
  const result = writeResult(home, o, res, startedAt, endedAt, totalDuration, attempts);
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

const cmdCatalogList = () => {
  const dir = catalogDirPath();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const names = entries.filter((n) => existsSync(path.join(dir, n, "manifest.json"))).sort();
  if (!names.length) {
    console.log("(no catalog entries in " + path.relative(UP, dir) + "/)");
    return;
  }
  for (const name of names) {
    let m;
    try {
      m = JSON.parse(readFileSync(path.join(dir, name, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    console.log(
      `${name}\t${m.model || "(inherit)"}\t${m.max_tokens ?? "-"}\t${[m.nestable && "+nest", m.web && "+web"].filter(Boolean).join(" ")}\t${m.description || ""}`
    );
  }
};

const cmdCatalogShow = (argv) => {
  const name = argv[0];
  if (!name) fail("usage: alter.mjs catalog show <name>");
  const manifestPath = path.join(catalogDirPath(), sanitizeName(name), "manifest.json");
  if (!existsSync(manifestPath)) fail("catalog entry not found: " + name);
  process.stdout.write(readFileSync(manifestPath, "utf8"));
};

const cmdCatalogSave = (argv) => {
  const name = argv[0];
  if (!name) fail("usage: alter.mjs catalog save <name> [--from <alter-id>] [...spawn flags]");
  const rest = argv.slice(1);
  let fromId = null;
  let force = false;
  const passthrough = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--from") fromId = rest[++i];
    else if (rest[i] === "--force") force = true;
    else passthrough.push(rest[i]);
  }
  const sanitized = sanitizeName(name);
  const dir = path.join(catalogDirPath(), sanitized);
  if (existsSync(dir) && !force) {
    fail(`catalog entry already exists: ${sanitized} (pass --force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  let manifest;
  if (fromId) {
    const home = resolveHome(fromId);
    const aj = readAlterJson(home);
    manifest = {
      name: sanitized,
      description: aj.description || "Single-use sandboxed Alter.",
      model: aj.model || null,
      fallback_model: aj.fallback_model || null,
      max_tokens: aj.max_tokens ?? null,
      nestable: !!aj.nestable,
      web: !!aj.web,
      timeout_ms: null,
      read_grants: aj.read_grants || [],
      write_grants: aj.write_grants || [],
      prompt_prefix: null,
      prompt_suffix: null,
      agents_md_override: null,
      skills_dir: null,
      source: { type: "local", ref: null },
      created_at: iso(Date.now()),
      created_from: aj.id || fromId,
    };
  } else {
    // Flags-only mode: reuse parseSpawnArgs (it requires a prompt, so supply a placeholder —
    // catalog entries don't carry a fixed prompt of their own).
    const o = parseSpawnArgs([...passthrough, "--prompt", "(catalog entry; unused)"]);
    manifest = {
      name: sanitized,
      description: o.description || "Single-use sandboxed Alter.",
      model: o.model || null,
      fallback_model: o.fallbackModel || null,
      max_tokens: o.maxTokens ?? null,
      nestable: !!o.nestable,
      web: !!o.webAccess,
      timeout_ms: o.timeout ?? null,
      read_grants: o.readGrants || [],
      write_grants: o.writeGrants || [],
      prompt_prefix: o.promptPrefix ?? null,
      prompt_suffix: o.promptSuffix ?? null,
      agents_md_override: null,
      skills_dir: null,
      source: { type: "local", ref: null },
      created_at: iso(Date.now()),
      created_from: null,
    };
  }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("saved catalog entry: " + path.relative(UP, dir));
};

const cmdCatalog = (argv) => {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") cmdCatalogList();
  else if (sub === "show") cmdCatalogShow(rest);
  else if (sub === "save") cmdCatalogSave(rest);
  else fail("usage: alter.mjs catalog <list|show|save> ...");
};

const usage = () => {
  console.error("usage: alter.mjs <command> [args]");
  console.error("");
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

const cmd = process.argv[2];
const rest = process.argv.slice(3);
if (cmd === "spawn") cmdSpawn(rest);
else if (cmd === "create") cmdSpawn(rest, { createOnly: true });
else if (cmd === "run") cmdRun(rest);
else if (cmd === "list" || cmd === "ls") cmdList();
else if (cmd === "tree") cmdTree();
else if (cmd === "show") cmdShow(rest);
else if (cmd === "rm") cmdRm(rest);
else if (cmd === "catalog") cmdCatalog(rest);
else usage();
