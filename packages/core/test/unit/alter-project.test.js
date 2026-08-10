// An Alter authored as a project is a directory the user edits and the spawner copies.
// Two properties carry the whole feature and neither is visible from the happy path:
// the copy must not be able to reach outside the project, and a manifest that points at
// a file which is not there must fail loudly rather than fall back to the stock persona
// (buildBody swallows the failed read, so the fallback looks exactly like success).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFrontmatter,
  createProjectSkill,
  deleteProjectFile,
  listProjectFiles,
  listProjectSkills,
  readSkillFrontmatter,
  resolveCatalogEntry,
  saveCatalogEntry,
  scaffoldAlterProject,
  validateManifest,
  writeProjectFile,
} from "../../src/index.js";

const CFG = { catalog_dir: "catalog" };

const projectRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-project-"));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify(CFG));
  return root;
};

const entryDir = (root, name) => path.join(root, ".alters", "catalog", name);

const saveProject = (root, name, options = {}) =>
  saveCatalogEntry(root, CFG, name, { description: "A project Alter.", ...options }, { project: true });

test("saving a project entry seeds the files its manifest points at", () => {
  const root = projectRoot();
  const dir = saveProject(root, "researcher");

  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.agents_md_override, "AGENTS.md");
  assert.equal(manifest.skills_dir, "skills");
  assert.ok(existsSync(path.join(dir, "AGENTS.md")));
  assert.ok(existsSync(path.join(dir, "skills")));

  // The seeded persona keeps the placeholders the compiler substitutes, so an author
  // editing it sees the same seams buildBody does.
  assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /\{\{ROLE_BLOCK\}\}/);

  // And it resolves — which is the assertion that matters, since resolveCatalogEntry is
  // where a dangling reference now becomes an error.
  const entry = resolveCatalogEntry(root, CFG, "researcher");
  assert.equal(entry.manifest.skills_dir, "skills");
});

test("a non-project entry is unchanged", () => {
  const root = projectRoot();
  const dir = saveCatalogEntry(root, CFG, "plain", { description: "A plain Alter." });
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

  assert.equal(manifest.agents_md_override, null);
  assert.equal(manifest.skills_dir, null);
  assert.ok(!existsSync(path.join(dir, "AGENTS.md")));
  assert.deepEqual(listProjectFiles(dir).map((f) => f.path), ["manifest.json"]);
});

test("a manifest pointing at a missing persona fails instead of falling back", () => {
  const root = projectRoot();
  const dir = saveProject(root, "broken");
  deleteProjectFile(dir, "AGENTS.md");

  assert.throws(
    () => resolveCatalogEntry(root, CFG, "broken"),
    /agents_md_override points at a missing file/,
  );
});

test("a bare --- rule in the persona is rejected rather than silently truncating it", () => {
  const root = projectRoot();
  const dir = saveProject(root, "ruled");
  writeProjectFile(dir, "AGENTS.md", "You are a careful reviewer.\n\n---\n\nNever commit.\n");

  assert.throws(() => resolveCatalogEntry(root, CFG, "ruled"), /would silently truncate/);
});

test("real frontmatter in the persona is fine", () => {
  const root = projectRoot();
  const dir = saveProject(root, "fronted");
  writeProjectFile(dir, "AGENTS.md", "---\ndescription: x\n---\n\nYou are a careful reviewer.\n");

  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "fronted"));
});

test("a skill without a description is rejected, since it could never be selected", () => {
  const root = projectRoot();
  const dir = saveProject(root, "mute");
  writeProjectFile(dir, "skills/triage/SKILL.md", "# Skill: triage\n\nDo the thing.\n");

  assert.throws(() => resolveCatalogEntry(root, CFG, "mute"), /has no description/);
});

test("created skills carry a usable description and are listed", () => {
  const root = projectRoot();
  const dir = saveProject(root, "helper");

  createProjectSkill(dir, "code review", { description: "Use when reviewing a diff." });
  createProjectSkill(dir, "triage");

  const skills = listProjectSkills(dir);
  assert.deepEqual(skills.map((s) => s.name), ["code_review", "triage"]);
  assert.equal(skills[0].description, "Use when reviewing a diff.");
  // An empty description would make the skill unreachable, so one is synthesised.
  assert.match(skills[1].description, /triage/);
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "helper"));
  assert.throws(() => createProjectSkill(dir, "triage"), /already exists/);
});

test("skills force the skill tool on even when the alter otherwise denies tools", () => {
  const withSkills = buildFrontmatter({
    description: "d",
    bashOnly: true,
    readGrants: [],
    writeGrants: [],
    catalogEntryDir: "/some/entry",
    catalogSkillsDir: "skills",
  });
  const without = buildFrontmatter({ description: "d", bashOnly: true, readGrants: [], writeGrants: [] });

  assert.match(withSkills, /^ {2}skill: allow$/m);
  assert.match(without, /^ {2}skill: deny$/m);
});

test("text_only and skills_dir cannot be combined", () => {
  assert.throws(
    () => validateManifest({ name: "t", description: "d", text_only: true, skills_dir: "skills" }, "t"),
    /text_only cannot be combined with skills_dir/,
  );
});

test("manifest paths must stay inside the entry directory", () => {
  const base = { name: "t", description: "d" };
  assert.throws(() => validateManifest({ ...base, skills_dir: "../../etc" }, "t"), /must stay inside/);
  assert.throws(() => validateManifest({ ...base, agents_md_override: "/etc/passwd" }, "t"), /must stay inside/);
  assert.throws(() => validateManifest({ ...base, skills_dir: "  " }, "t"), /non-empty relative path/);
});

test("project writes cannot escape the project directory", () => {
  const root = projectRoot();
  const dir = saveProject(root, "confined");

  for (const escape of ["../escape.md", "skills/../../escape.md", "/tmp/escape.md"]) {
    assert.throws(() => writeProjectFile(dir, escape, "x"), /escapes the project|must be relative/);
  }
  assert.throws(() => writeProjectFile(dir, "payload.sh", "#!/bin/sh"), /must be text/);
  assert.throws(() => deleteProjectFile(dir, "manifest.json"), /cannot be deleted/);
});

test("a symlinked directory is not a way out of the project", () => {
  const root = projectRoot();
  const dir = saveProject(root, "linked");
  const outside = mkdtempSync(path.join(tmpdir(), "mind-outside-"));
  symlinkSync(outside, path.join(dir, "escape"));

  assert.throws(() => writeProjectFile(dir, "escape/owned.md", "x"), /outside the project/);
  assert.ok(!existsSync(path.join(outside, "owned.md")));
});

test("skill frontmatter parsing handles quotes and colons in the value", () => {
  const meta = readSkillFrontmatter('---\nname: triage\ndescription: "Use when: a bug arrives."\n---\nbody\n');
  assert.equal(meta.name, "triage");
  assert.equal(meta.description, "Use when: a bug arrives.");
  assert.deepEqual(readSkillFrontmatter("no frontmatter here"), {});
});

test("scaffolding never clobbers a persona the author already wrote", () => {
  const root = projectRoot();
  const dir = saveProject(root, "precious");
  writeProjectFile(dir, "AGENTS.md", "MINE\n");

  scaffoldAlterProject(dir, { description: "again" });
  assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "MINE\n");
});

test("listing a project's files reports what an editor would show", () => {
  const root = projectRoot();
  const dir = saveProject(root, "listed");
  createProjectSkill(dir, "triage", { description: "Use when triaging." });

  assert.deepEqual(
    listProjectFiles(dir).map((f) => f.path),
    ["AGENTS.md", "manifest.json", "skills/.gitkeep", "skills/triage/SKILL.md"],
  );
  assert.ok(listProjectFiles(dir).every((f) => f.editable));
  assert.ok(listProjectFiles(entryDir(root, "listed")).every((f) => f.bytes >= 0));
});
