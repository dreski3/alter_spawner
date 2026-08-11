// An Alter is authored as a project and run as a copy. The project is the catalog
// entry directory: a manifest declaring the tools, an AGENTS.md holding the persona,
// and a skills/ tree the model loads on demand. `scaffold` compiles that into a run
// home at spawn time, which is what makes editing safe — a change lands on every
// future run and on no running one, because a run already holds its own copy.
//
// The manifest always had the two seams this needs (`agents_md_override`, `skills_dir`)
// and both `applyCatalog` and `scaffold` already honoured them. What was missing was
// anything that authored, validated, or read back the files they point at, so every
// shipped manifest left them null. That is what lives here.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fail, sanitizeName } from "./util.js";
import { writeTextAtomic } from "./persistence.js";
import { TEMPLATE_PROJECT_AGENTS_MD, TEMPLATE_PROJECT_SKILL } from "./paths.js";

export const PROJECT_AGENTS_FILE = "AGENTS.md";
export const PROJECT_SKILLS_DIR = "skills";
export const PROJECT_SKILL_FILE = "SKILL.md";

// Everything in a project is text an author wrote by hand, and every byte of it is
// copied into a run home where the Alter can reach it. So the extension list is a
// boundary, not a convenience: it is what stops a project from shipping a binary or
// an executable into a sandbox that was scoped assuming only prose would arrive.
const EDITABLE_EXTENSIONS = new Set([".md", ".json", ".txt", ".yaml", ".yml"]);
// Git does not track empty directories, so a project with a skills/ folder and no
// skills yet needs one real file to survive being committed and cloned.
const EDITABLE_BASENAMES = new Set([".gitkeep"]);

// A project file is paid for on every spawn, forever. The cap is small on purpose:
// anything approaching it belongs in a skill that loads on demand, not in the
// persona that ships with every run.
export const MAX_PROJECT_FILE_BYTES = 256 * 1024;

const IGNORED_DIRS = new Set([".git", "node_modules"]);
const MAX_PROJECT_FILES = 200;
const MAX_PROJECT_TREE_DEPTH = 8;

export const isEditableProjectFile = (relPath) =>
  EDITABLE_BASENAMES.has(path.basename(relPath)) || EDITABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());

export const inspectProjectTree = (
  dir,
  { action = "use project", maxDepth = MAX_PROJECT_TREE_DEPTH, maxFiles = MAX_PROJECT_FILES } = {},
) => {
  const base = path.resolve(dir);
  let root;
  try {
    root = lstatSync(base);
  } catch (error) {
    fail(`cannot ${action}: ${base} is not readable (${error.message}).`);
  }
  if (root.isSymbolicLink()) fail(`refusing to ${action} a symlink: .`);
  if (!root.isDirectory()) fail(`cannot ${action}: ${base} is not a directory.`);

  const state = { count: 0 };
  const visit = (current, depth) => {
    const relativeDir = path.relative(base, current) || ".";
    if (depth > maxDepth) fail(`refusing to ${action}: ${relativeDir} is nested more than ${maxDepth} deep.`);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const shown = path.relative(base, full) || entry.name;
      if (entry.isSymbolicLink()) fail(`refusing to ${action} a symlink: ${shown}`);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) fail(`refusing to ${action} a special file: ${shown}`);
      const { size } = statSync(full);
      if (size > MAX_PROJECT_FILE_BYTES) {
        fail(`refusing to ${action} ${shown}: ${size} bytes exceeds the ${MAX_PROJECT_FILE_BYTES}-byte project file limit.`);
      }
      state.count += 1;
      if (state.count > maxFiles) fail(`refusing to ${action}: more than ${maxFiles} files.`);
    }
  };
  visit(base, 0);
  return state.count;
};

// `path.resolve` collapses "..", so comparing the resolved result against the base is
// what actually stops traversal. Screening the input string for ".." would miss the
// same escape spelled differently, and would reject the legitimate "a..b.md".
const confine = (entryDir, relPath, label) => {
  if (typeof relPath !== "string" || !relPath.trim()) fail(`${label}: a relative path is required.`);
  if (path.isAbsolute(relPath)) fail(`${label}: path must be relative to the project (got "${relPath}").`);
  const base = path.resolve(entryDir);
  const target = path.resolve(base, relPath);
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`${label}: path escapes the project directory (got "${relPath}").`);
  }
  return target;
};

// Confining the resolved path is not enough on its own: any directory already on the
// way down could be a symlink out of the project, and a write would follow it. The
// leaf may legitimately not exist yet, so this walks up to the nearest ancestor that
// does and checks where that really lives.
const assertNoSymlinkEscape = (entryDir, target, label) => {
  let realBase;
  try {
    realBase = realpathSync(path.resolve(entryDir));
  } catch {
    return; // The project itself is gone; the caller's own existence check will say so.
  }
  let probe = target;
  while (!existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  let realProbe;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return;
  }
  const rel = path.relative(realBase, realProbe);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`${label}: path resolves through a link outside the project.`);
  }
};

export const resolveProjectPath = (entryDir, relPath, { label = "project file" } = {}) => {
  const target = confine(entryDir, relPath, label);
  assertNoSymlinkEscape(entryDir, target, label);
  return target;
};

// SKILL.md frontmatter is a fenced block of `key: value` lines. A YAML parser would be
// a dependency for the two keys that matter, and skills are authored against opencode's
// own reader, which wants nothing more nested than this. Values spanning lines are not
// supported and never appear in practice — a description is one long line.
export const readSkillFrontmatter = (text) => {
  if (typeof text !== "string" || !text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out = {};
  for (const line of text.slice(3, end).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const walk = (dir, base, depth, out) => {
  if (depth > MAX_PROJECT_TREE_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), base, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue; // Symlinks are listed by neither name nor target.
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    let bytes = 0;
    try {
      bytes = statSync(full).size;
    } catch {}
    out.push({ path: rel, bytes, editable: isEditableProjectFile(rel) });
  }
};

export const listProjectFiles = (entryDir) => {
  const out = [];
  walk(path.resolve(entryDir), path.resolve(entryDir), 0, out);
  return out;
};

export const readProjectFile = (entryDir, relPath) => {
  const target = resolveProjectPath(entryDir, relPath);
  if (!existsSync(target)) fail(`project file not found: ${relPath}`);
  const { size } = statSync(target);
  if (size > MAX_PROJECT_FILE_BYTES) {
    fail(`project file is too large to read: ${relPath} (${size} bytes, limit ${MAX_PROJECT_FILE_BYTES}).`);
  }
  return readFileSync(target, "utf8");
};

export const writeProjectFile = (entryDir, relPath, content) => {
  const target = resolveProjectPath(entryDir, relPath);
  if (!isEditableProjectFile(relPath)) {
    fail(`project files must be text (${[...EDITABLE_EXTENSIONS].join(", ")}); refusing to write ${relPath}.`);
  }
  const text = String(content ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PROJECT_FILE_BYTES) {
    fail(`project file is too large to write: ${relPath} (${bytes} bytes, limit ${MAX_PROJECT_FILE_BYTES}).`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeTextAtomic(target, text);
  return target;
};

export const deleteProjectFile = (entryDir, relPath) => {
  const target = resolveProjectPath(entryDir, relPath);
  // manifest.json is the entry itself, not a file of the project: without it
  // `listCatalogEntries` stops seeing the Alter at all and the UI loses its handle
  // on the very directory it would need to repair.
  if (path.relative(path.resolve(entryDir), target) === "manifest.json") {
    fail("manifest.json cannot be deleted; delete the catalog entry instead.");
  }
  if (!existsSync(target)) fail(`project file not found: ${relPath}`);
  rmSync(target, { recursive: true, force: true });
};

// A skills directory holds one directory per skill, each with a SKILL.md. Anything else
// in there is ignored rather than rejected: opencode ignores it too, so failing would
// invent a rule the runtime does not have.
export const listProjectSkills = (entryDir, skillsDir = PROJECT_SKILLS_DIR) => {
  if (!skillsDir) return [];
  let root;
  try {
    root = resolveProjectPath(entryDir, skillsDir, { label: "skills_dir" });
  } catch {
    return [];
  }
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const file = path.join(root, entry.name, PROJECT_SKILL_FILE);
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    const meta = readSkillFrontmatter(text);
    out.push({
      name: entry.name,
      description: meta.description || "",
      path: [skillsDir, entry.name, PROJECT_SKILL_FILE].join("/"),
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }
  return out;
};

const applySkillPlaceholders = (template, { name, description }) =>
  template.replace(/\{\{SKILL_NAME\}\}/g, name).replace(/\{\{SKILL_DESCRIPTION\}\}/g, description);

export const createProjectSkill = (entryDir, name, { description = "", skillsDir = PROJECT_SKILLS_DIR } = {}) => {
  const sanitized = sanitizeName(name);
  if (!sanitized) fail(`"${name}" is not a usable skill name.`);
  const relPath = [skillsDir, sanitized, PROJECT_SKILL_FILE].join("/");
  const target = resolveProjectPath(entryDir, relPath, { label: "skill" });
  if (existsSync(target)) fail(`skill already exists: ${sanitized}`);
  let template = "";
  try {
    template = readFileSync(TEMPLATE_PROJECT_SKILL, "utf8");
  } catch {
    template = "---\ndescription: {{SKILL_DESCRIPTION}}\n---\n\n# Skill: {{SKILL_NAME}}\n";
  }
  const body = applySkillPlaceholders(template, {
    name: sanitized,
    // opencode decides whether to load a skill from this line alone, so an empty
    // description would make the skill unreachable rather than merely undocumented.
    description: description.trim() || `Use when the task involves ${sanitized}.`,
  });
  writeProjectFile(entryDir, relPath, body);
  return { name: sanitized, path: relPath, file: target };
};

// Seeds the files the manifest is about to point at. Never clobbers: `--force` on a
// catalog save means "replace the configuration", and silently overwriting a persona
// the author spent time on is not something that flag asked for.
export const scaffoldAlterProject = (entryDir, { description = "" } = {}) => {
  mkdirSync(path.join(entryDir, PROJECT_SKILLS_DIR), { recursive: true });
  const gitkeep = path.join(entryDir, PROJECT_SKILLS_DIR, ".gitkeep");
  if (!existsSync(gitkeep)) writeTextAtomic(gitkeep, "");
  const agentsPath = path.join(entryDir, PROJECT_AGENTS_FILE);
  if (!existsSync(agentsPath)) {
    let template = "";
    try {
      template = readFileSync(TEMPLATE_PROJECT_AGENTS_MD, "utf8");
    } catch {
      template = "{{ROLE_BLOCK}}\n";
    }
    // ROLE_BLOCK and NESTING_BLOCK are substituted by `buildBody` at spawn time, when
    // the description and nestability are actually known. They stay as placeholders on
    // disk so an author editing the file sees the same seams the compiler does.
    writeTextAtomic(agentsPath, template);
  }
  return {
    agents_md_override: PROJECT_AGENTS_FILE,
    skills_dir: PROJECT_SKILLS_DIR,
    description,
  };
};

export const isAlterProject = (manifest) => !!(manifest && (manifest.agents_md_override || manifest.skills_dir));

// Called once the manifest itself is known to be well formed, to check the thing a
// manifest alone cannot: that the files it names are actually there. This matters
// because `buildBody` swallows a failed read and falls back to the stock template —
// so without this, a typo in `agents_md_override` would produce a generic Alter that
// looks like it worked instead of an error that says what is wrong.
export const validateAlterProject = (dir, m, name) => {
  const label = `catalog entry "${name}"`;
  if (isAlterProject(m)) inspectProjectTree(dir, { action: `use ${label}` });
  if (m.agents_md_override) {
    const target = resolveProjectPath(dir, m.agents_md_override, { label: `${label}: agents_md_override` });
    if (!existsSync(target)) {
      fail(`${label}: agents_md_override points at a missing file (${m.agents_md_override}).`);
    }
    const text = readFileSync(target, "utf8");
    // `buildBody` strips everything before the first "\n---\n", so it can read an
    // authored file's markdown horizontal rule as the end of a frontmatter block that
    // was never opened and silently drop the persona above it. Frontmatter proper is
    // fine — that is what the stripping is for — but a bare rule is not.
    if (!text.startsWith("---") && text.includes("\n---\n")) {
      fail(
        `${label}: ${m.agents_md_override} contains a "---" line, which is read as the end of ` +
          `frontmatter and would silently truncate everything above it. Use "***" for a horizontal rule.`
      );
    }
  }
  if (m.skills_dir) {
    const target = resolveProjectPath(dir, m.skills_dir, { label: `${label}: skills_dir` });
    // An empty or absent skills directory is a project mid-authoring, not a broken one.
    if (existsSync(target) && !statSync(target).isDirectory()) {
      fail(`${label}: skills_dir must be a directory (${m.skills_dir}).`);
    }
    for (const skill of listProjectSkills(dir, m.skills_dir)) {
      if (!skill.description) {
        fail(
          `${label}: skill "${skill.name}" has no description in its frontmatter. ` +
            `The description is the only thing the model sees when deciding to load a skill, ` +
            `so a skill without one can never be selected.`
        );
      }
    }
  }
};

// The whole project in one read, for a caller that wants to show it rather than run it.
export const readAlterProject = (dir, m) => ({
  isProject: isAlterProject(m),
  agentsPath: m?.agents_md_override || null,
  agents:
    m?.agents_md_override && existsSync(path.join(dir, m.agents_md_override))
      ? readFileSync(path.join(dir, m.agents_md_override), "utf8")
      : null,
  skillsDir: m?.skills_dir || null,
  skills: listProjectSkills(dir, m?.skills_dir),
  files: listProjectFiles(dir),
});
