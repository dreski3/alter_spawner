// Moving an Alter project between machines. The files themselves are portable by
// construction — manifest.json, AGENTS.md and skills/ are all plain text — so export is a
// copy out and import is a copy back.
//
// What does not travel is trust. The manifest that rides along also declares which
// directories the Alter may read and write, which shell commands it may run, whether it
// may spawn children, and which provider endpoint its model is called through. Those are
// decisions about *this* machine, and a directory that arrived from somewhere else has no
// standing to make them — an imported entry could otherwise grant itself the user's home
// directory and a shell on first spawn, with nothing on screen having asked. So import
// drops them by default and reports exactly what it dropped.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fail, sanitizeName } from "./util.js";
import { writeJsonAtomic } from "./persistence.js";
import { catalogDirPath, resolveCatalogEntry, validateManifest } from "./catalog.js";
import { inspectProjectTree, listProjectFiles, validateAlterProject } from "./alter-project.js";

// Each maps to the value an untrusted import is reduced to. `web` is deliberately absent:
// network access cannot reach this machine's files or shell, it is what a research Alter
// is *for*, and stripping it would silently produce an Alter that no longer does its job.
// It is reported in the summary instead.
export const PRIVILEGED_MANIFEST_FIELDS = Object.freeze({
  read_grants: [],
  write_grants: [],
  bash_allow: [],
  nestable: false,
  opencode_provider: null,
  executor: null,
  capability: null,
});

const PORTABLE_EXECUTORS = new Set(["opencode", "llm"]);

const isSet = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

const installDirectory = (source, target, { force = false, prepare } = {}) => {
  if (existsSync(target) && !force) fail(`target already exists: ${target}`);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const staged = mkdtempSync(path.join(parent, `.${path.basename(target)}.staged-`));
  try {
    cpSync(source, staged, { recursive: true, force: true });
    prepare?.(staged);

    let backup = null;
    if (existsSync(target)) {
      backup = mkdtempSync(path.join(parent, `.${path.basename(target)}.backup-`));
      rmSync(backup, { recursive: true, force: true });
      renameSync(target, backup);
    }
    try {
      renameSync(staged, target);
    } catch (error) {
      if (backup) renameSync(backup, target);
      throw error;
    }
    if (backup) rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
};

export const exportCatalogEntry = (root, cfg, name, destination, { force = false } = {}) => {
  const sanitized = sanitizeName(name);
  const source = path.join(catalogDirPath(root, cfg), sanitized);
  if (!existsSync(path.join(source, "manifest.json"))) fail(`catalog entry not found: ${name}`);
  if (!destination) fail("an export destination directory is required");
  const target = path.resolve(destination, sanitized);
  if (existsSync(target) && !force) {
    fail(`export target already exists: ${target} (pass --force to overwrite)`);
  }
  resolveCatalogEntry(root, cfg, sanitized);
  inspectProjectTree(source, { action: "export" });
  installDirectory(source, target, { force });
  return { name: sanitized, source, target, files: listProjectFiles(target) };
};

export const importCatalogEntry = (root, cfg, source, { as = null, force = false, trust = false } = {}) => {
  const dir = path.resolve(source);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json in ${dir} — that is not an exported alter project.`);
  }
  inspectProjectTree(dir, { action: "import" });

  let incoming;
  try {
    incoming = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`${manifestPath} is not valid JSON (${e.message}).`);
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    fail(`${manifestPath} does not contain a manifest object.`);
  }

  const name = sanitizeName(as || incoming.name || path.basename(dir));
  if (!name) fail(`"${as || incoming.name || path.basename(dir)}" is not a usable catalog name.`);

  // validateManifest requires the manifest's own name to match its folder, so a rename is
  // a rewrite rather than just a different destination.
  const manifest = { ...incoming, name, source: { type: "local", ref: null } };
  // `privileged` is what the manifest asked for and is computed either way — a caller
  // that passed `trust` still has to be able to say what it just accepted, and reporting
  // only what was dropped makes a trusted import of a shell grant indistinguishable from
  // a trusted import of nothing at all.
  const privileged = Object.keys(PRIVILEGED_MANIFEST_FIELDS)
    .filter((field) => {
      if (!isSet(incoming[field])) return false;
      if (field === "executor") return !PORTABLE_EXECUTORS.has(incoming.executor);
      return true;
    })
    .map((field) => ({ field, was: incoming[field] }));
  if (!trust) {
    for (const { field } of privileged) {
      const safe = PRIVILEGED_MANIFEST_FIELDS[field];
      manifest[field] = Array.isArray(safe) ? [] : safe;
    }
  }
  const dropped = trust ? [] : privileged;
  // Reported rather than stripped — see PRIVILEGED_MANIFEST_FIELDS.
  const notable = incoming.web ? ["web"] : [];

  validateManifest(manifest, name);

  const target = path.join(catalogDirPath(root, cfg), name);
  if (existsSync(target) && !force) {
    fail(`catalog entry already exists: ${name} (pass --force to overwrite)`);
  }
  installDirectory(dir, target, {
    force,
    prepare: (staged) => {
      writeJsonAtomic(path.join(staged, "manifest.json"), manifest);
      validateAlterProject(staged, manifest, name);
    },
  });

  return { name, dir: target, manifest, privileged, dropped, notable };
};
