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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fail, sanitizeName } from "./util.js";
import { writeJsonAtomic } from "./persistence.js";
import { catalogDirPath, validateManifest } from "./catalog.js";
import { listProjectFiles, MAX_PROJECT_FILE_BYTES, validateAlterProject } from "./alter-project.js";

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
});

const MAX_PROJECT_FILES = 200;
const MAX_DEPTH = 8;

const isSet = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

// A symlink in the source tree would be copied as a link, land in the catalog, and be
// followed into the run home on the next spawn — turning a file the user reviewed into a
// window onto one they did not. Refusing outright is cheap: a project is text files.
const inspectTree = (dir, base, depth = 0) => {
  if (depth > MAX_DEPTH) fail(`refusing to import: ${path.relative(base, dir)} is nested more than ${MAX_DEPTH} deep.`);
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const shown = path.relative(base, full) || entry.name;
    if (entry.isSymbolicLink()) fail(`refusing to import a symlink: ${shown}`);
    if (entry.isDirectory()) {
      count += inspectTree(full, base, depth + 1);
      continue;
    }
    if (!entry.isFile()) fail(`refusing to import a special file: ${shown}`);
    const { size } = statSync(full);
    if (size > MAX_PROJECT_FILE_BYTES) {
      fail(`refusing to import ${shown}: ${size} bytes exceeds the ${MAX_PROJECT_FILE_BYTES}-byte project file limit.`);
    }
    count += 1;
    if (count > MAX_PROJECT_FILES) fail(`refusing to import: more than ${MAX_PROJECT_FILES} files.`);
  }
  return count;
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
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  return { name: sanitized, source, target, files: listProjectFiles(target) };
};

export const importCatalogEntry = (root, cfg, source, { as = null, force = false, trust = false } = {}) => {
  const dir = path.resolve(source);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json in ${dir} — that is not an exported alter project.`);
  }
  inspectTree(dir, dir);

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
  const manifest = { ...incoming, name };
  // `privileged` is what the manifest asked for and is computed either way — a caller
  // that passed `trust` still has to be able to say what it just accepted, and reporting
  // only what was dropped makes a trusted import of a shell grant indistinguishable from
  // a trusted import of nothing at all.
  const privileged = Object.keys(PRIVILEGED_MANIFEST_FIELDS)
    .filter((field) => isSet(incoming[field]))
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
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(dir, target, { recursive: true, force: true });
  // Written after the copy so the sanitized manifest wins over the one that travelled.
  writeJsonAtomic(path.join(target, "manifest.json"), manifest);
  // Last, because it reads the files that were just laid down: a project whose persona or
  // skills are unusable must fail here rather than at the first spawn.
  validateAlterProject(target, manifest, name);

  return { name, dir: target, manifest, privileged, dropped, notable };
};
