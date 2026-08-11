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
  buildBody,
  applyCatalog,
  convertCatalogEntryToProject,
  createSpawnOptions,
  createProjectSkill,
  deleteProjectFile,
  listProjectFiles,
  listProjectSkills,
  readSkillFrontmatter,
  resolveCatalogEntry,
  saveCatalogEntry,
  scaffold,
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

test("re-saving an entry carries its project paths instead of orphaning the files", () => {
  const root = projectRoot();
  saveProject(root, "kept");
  const before = JSON.parse(readFileSync(path.join(entryDir(root, "kept"), "manifest.json"), "utf8"));

  // What the bridge does on an edit: read the manifest, rebuild options from it, force-save.
  saveCatalogEntry(
    root,
    CFG,
    "kept",
    {
      description: "An edited description.",
      agentsMdOverride: before.agents_md_override,
      skillsDir: before.skills_dir,
    },
    { force: true },
  );

  const after = JSON.parse(readFileSync(path.join(entryDir(root, "kept"), "manifest.json"), "utf8"));
  assert.equal(after.description, "An edited description.");
  assert.equal(after.agents_md_override, "AGENTS.md");
  assert.equal(after.skills_dir, "skills");
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "kept"));
});

test("a custom project path survives a re-save rather than snapping back to the default", () => {
  const root = projectRoot();
  const dir = saveProject(root, "custom");
  writeProjectFile(dir, "persona.md", "You are custom.\n");

  saveCatalogEntry(
    root,
    CFG,
    "custom",
    { description: "d", agentsMdOverride: "persona.md", skillsDir: "skills" },
    { force: true },
  );

  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.agents_md_override, "persona.md");
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

test("converting a plain entry into a project preserves every other field", () => {
  const root = projectRoot();
  saveCatalogEntry(root, CFG, "grown", {
    description: "Was plain.",
    maxTokens: 8000,
    webAccess: true,
    promptPrefix: "Be terse.",
  });

  const { manifest } = convertCatalogEntryToProject(root, CFG, "grown");
  assert.equal(manifest.agents_md_override, "AGENTS.md");
  assert.equal(manifest.skills_dir, "skills");
  assert.equal(manifest.max_tokens, 8000);
  assert.equal(manifest.web, true);
  assert.equal(manifest.prompt_prefix, "Be terse.");
  assert.ok(existsSync(path.join(entryDir(root, "grown"), "AGENTS.md")));
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "grown"));
});

test("a text_only entry converts to a persona-only project without enabling skills", () => {
  const root = projectRoot();
  saveCatalogEntry(root, CFG, "terse", { description: "Text in, text out.", textOnly: true });

  const { manifest } = convertCatalogEntryToProject(root, CFG, "terse");
  assert.equal(manifest.agents_md_override, "AGENTS.md");
  assert.equal(manifest.skills_dir, null);
  assert.ok(existsSync(path.join(entryDir(root, "terse"), "AGENTS.md")));
  assert.ok(!existsSync(path.join(entryDir(root, "terse"), "skills")));
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "terse"));
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

test("a project persona and its skills are compiled into an isolated run home", () => {
  const root = projectRoot();
  const dir = saveProject(root, "specialist");
  writeProjectFile(dir, "AGENTS.md", "{{ROLE_BLOCK}}\n\nCUSTOM PERSONA\n{{NESTING_BLOCK}}\n");
  createProjectSkill(dir, "triage", { description: "Use when triaging an incident." });

  const entry = resolveCatalogEntry(root, CFG, "specialist");
  const options = createSpawnOptions({
    id: "specialist-run",
    name: "specialist-run",
    model: "test/model",
    depth: 0,
    spawned_by: "root",
  });
  applyCatalog(options, entry);
  const home = scaffold(root, CFG, options);
  const agent = readFileSync(path.join(home, ".opencode", "agents", "alter.md"), "utf8");
  const skill = readFileSync(path.join(home, ".opencode", "skills", "triage", "SKILL.md"), "utf8");

  assert.match(agent, /CUSTOM PERSONA/);
  assert.match(agent, /## Your role\nA project Alter\./);
  assert.doesNotMatch(agent, /\{\{ROLE_BLOCK\}\}/);
  assert.match(agent, /^ {2}skill: allow$/m);
  assert.match(skill, /Use when triaging an incident\./);
});

test("a nested skill symlink is rejected before it can become a live link in a run", () => {
  const root = projectRoot();
  const dir = saveProject(root, "linked-skill");
  writeProjectFile(dir, "payload.md", "---\ndescription: Use when linked.\n---\n");
  mkdirSync(path.join(dir, "skills", "linked"), { recursive: true });
  symlinkSync("../../payload.md", path.join(dir, "skills", "linked", "SKILL.md"));

  assert.throws(() => resolveCatalogEntry(root, CFG, "linked-skill"), /refusing to use .* a symlink/);
  const options = createSpawnOptions({
    id: "linked-run",
    name: "linked-run",
    model: "test/model",
    depth: 0,
    spawned_by: "root",
    catalogEntryDir: dir,
    catalogAgentsOverride: "AGENTS.md",
    catalogSkillsDir: "skills",
  });
  assert.throws(() => scaffold(root, CFG, options), /refusing to scaffold catalog entry a symlink/);
  assert.ok(!existsSync(path.join(root, ".alters", "runs")));
});

test("a text_only project uses its authored persona while keeping the fixed result contract", () => {
  const root = projectRoot();
  const dir = saveCatalogEntry(root, CFG, "text-specialist", {
    description: "A text specialist.",
    textOnly: true,
    agentsMdOverride: "AGENTS.md",
  });
  writeProjectFile(dir, "AGENTS.md", "{{ROLE_BLOCK}}\n\nCUSTOM TEXT PERSONA\n");

  const entry = resolveCatalogEntry(root, CFG, "text-specialist");
  const options = createSpawnOptions();
  applyCatalog(options, entry);
  const body = buildBody(options);

  assert.match(body, /CUSTOM TEXT PERSONA/);
  assert.match(body, /## Your role\nA text specialist\./);
  assert.match(body, /Return only the transformed\s+text/);
});
