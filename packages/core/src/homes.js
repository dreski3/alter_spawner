import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fail } from "./util.js";
import { runsDir } from "./config.js";
import { RESULT_SCHEMA_VERSION, writeJsonAtomic, writeTextAtomic } from "./persistence.js";

export const readAlterJson = (home) => {
  try {
    return JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
  } catch {
    return {};
  }
};

// Run folder names are timestamp-prefixed (see scaffold.js), so a plain
// alphabetical sort of folder names is also a chronological sort — last
// entry is the most recent run.
const listRunFolders = (root) => {
  let entries = [];
  try {
    entries = readdirSync(runsDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((n) => !n.startsWith("."))
    .map((n) => path.join(runsDir(root), n))
    .filter((p) => existsSync(path.join(p, "alter.json")))
    .sort();
};

// `--name`s are allowed to repeat across reruns, so a lookup by logical id
// (as opposed to an exact run-folder name) can match more than one home;
// the most recent one wins, matching what a user re-running the same named
// Alter almost always means by "it."
const findByLogicalId = (root, id) => {
  const matches = listRunFolders(root).filter((p) => readAlterJson(p).id === id);
  return matches.length ? matches[matches.length - 1] : null;
};

export const resolveHome = (root, arg) => {
  if (!arg) fail("missing <home-or-id>.");
  const asFolder = path.join(runsDir(root), arg);
  if (existsSync(asFolder) && existsSync(path.join(asFolder, "alter.json"))) return asFolder;
  const byId = findByLogicalId(root, arg);
  if (byId) return byId;
  const abs = path.resolve(arg);
  if (existsSync(abs)) return abs;
  fail("home not found: " + arg);
};

// `kitDirPath` is a `.alters`-shaped directory (either the project's own, or
// a nestable Alter's own `.alters/` for its children) — homes live one level
// deeper, under its `runs/` subfolder.
export const listHomes = (kitDirPath) => {
  const dir = path.join(kitDirPath, "runs");
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => !n.startsWith("."))
    .map((n) => path.join(dir, n))
    .filter((p) => existsSync(path.join(p, "alter.json")))
    .map((p) => ({ id: readAlterJson(p).id || path.basename(p), folder: path.basename(p), path: p }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
};

export const removeHome = (root, arg) => {
  if (!arg) fail("usage: mind rm <id-or-path>");
  const asFolder = path.join(runsDir(root), arg);
  let home = existsSync(asFolder) ? asFolder : findByLogicalId(root, arg);
  if (!home) home = path.resolve(arg);
  if (!existsSync(home)) fail("home not found: " + home);
  rmSync(home, { recursive: true, force: true });
  return home;
};

export const writeResult = (root, home, o, res, startedAt, endedAt, durationMs, attempts) => {
  const result = {
    schema_version: RESULT_SCHEMA_VERSION,
    id: o.id,
    ok: res.ok,
    exit_code: res.exitCode,
    killed: res.killed,
    aborted: res.aborted || false,
    budget_exceeded: res.budget_exceeded || false,
    empty_output: res.empty_output || false,
    contract_failed: res.contract_failed || false,
    contract_error: res.contract_error || null,
    max_tokens: o.maxTokens ?? null,
    text: res.text,
    tokens: res.tokens,
    steps: res.steps,
    // Null rather than an empty rollup when the harness cannot report tools at all (the
    // `llm` and `function` executors have none), so a reader can tell "no tools exist
    // here" from "tools exist and none were called". Runs written before this field
    // existed are also null, which is the same claim: nothing is known.
    tools: res.tools ? { calls: res.tools.calls, errors: res.tools.errors, by_name: { ...res.tools.byName } } : null,
    session_id: res.sessionID,
    event_log: res.eventLog ? path.relative(home, res.eventLog) : null,
    model: o.model,
    executor: o.executor || null,
    catalog: o.catalogName || null,
    depth: o.depth,
    home: path.relative(root, home),
    spawned_by: o.spawned_by,
    graph_id: o.graphId || null,
    depends_on: o.dependsOn || [],
    output_contract: o.outputContract || null,
    images: o.imageMetadata || [],
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    attempts: attempts || null,
  };
  writeJsonAtomic(path.join(home, "result.json"), result);
  writeTextAtomic(path.join(home, "result.md"), (res.text || "(no output)\n") + "\n");
  return result;
};
