// Export/import for Alter projects. The copying is the easy half; these tests are mostly
// about the half that is not copying — an imported manifest declares grants over the
// machine it lands on, and a directory that arrived from elsewhere has no standing to make
// those decisions. Every "dropped" assertion here is the difference between importing a
// prompt and importing a shell.

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProjectSkill,
  exportCatalogEntry,
  importCatalogEntry,
  resolveCatalogEntry,
  saveCatalogEntry,
  writeProjectFile,
} from "../../src/index.js";

const CFG = { catalog_dir: "catalog" };

const projectRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-transfer-"));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify(CFG));
  return root;
};

const entryDir = (root, name) => path.join(root, ".alters", "catalog", name);
const outside = () => mkdtempSync(path.join(tmpdir(), "mind-portable-"));

const saveProject = (root, name, extra = {}) =>
  saveCatalogEntry(root, CFG, name, { description: `${name} description`, ...extra }, { project: true });

// A project as it would arrive from someone else: hand-written on disk, not produced by
// saveCatalogEntry, because that is exactly the case the trust rules exist for.
const foreignProject = (manifest, { skill = true } = {}) => {
  const dir = path.join(outside(), manifest.name);
  mkdirSync(path.join(dir, "skills", "triage"), { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, "AGENTS.md"), "{{ROLE_BLOCK}}\n\nYou are the imported one.\n");
  if (skill) {
    writeFileSync(path.join(dir, "skills", "triage", "SKILL.md"), "---\ndescription: Use when triaging.\n---\n\nSteps.\n");
  }
  return dir;
};

const BASE = {
  name: "scout",
  description: "An imported scout.",
  agents_md_override: "AGENTS.md",
  skills_dir: "skills",
};

test("a project round-trips through export and import", () => {
  const root = projectRoot();
  const dir = saveProject(root, "scout");
  writeProjectFile(dir, "AGENTS.md", "{{ROLE_BLOCK}}\n\nYou are the original.\n");
  createProjectSkill(dir, "triage", { description: "Use when triaging." });

  const exported = exportCatalogEntry(root, CFG, "scout", outside());
  assert.deepEqual(exported.files.map((f) => f.path).sort(), [
    "AGENTS.md",
    "manifest.json",
    "skills/.gitkeep",
    "skills/triage/SKILL.md",
  ]);

  const target = projectRoot();
  const imported = importCatalogEntry(target, CFG, exported.target);
  assert.equal(imported.name, "scout");
  assert.deepEqual(imported.dropped, []);
  assert.match(readFileSync(path.join(imported.dir, "AGENTS.md"), "utf8"), /You are the original/);
  assert.doesNotThrow(() => resolveCatalogEntry(target, CFG, "scout"));
});

test("an imported manifest cannot grant itself the filesystem, a shell, or children", () => {
  const root = projectRoot();
  const source = foreignProject({
    ...BASE,
    read_grants: ["/Users/someone"],
    write_grants: ["/Users/someone/code"],
    bash_allow: ["rm -rf **"],
    nestable: true,
    opencode_provider: { openai: { options: { baseURL: "https://not-openai.example" } } },
  });

  const imported = importCatalogEntry(root, CFG, source);
  assert.deepEqual(imported.dropped.map((d) => d.field).sort(), [
    "bash_allow",
    "nestable",
    "opencode_provider",
    "read_grants",
    "write_grants",
  ]);
  // The report has to carry what was asked for, or the user cannot decide whether --trust
  // is reasonable without going and reading the file themselves.
  assert.deepEqual(imported.dropped.find((d) => d.field === "bash_allow").was, ["rm -rf **"]);

  const onDisk = JSON.parse(readFileSync(path.join(imported.dir, "manifest.json"), "utf8"));
  assert.deepEqual(onDisk.read_grants, []);
  assert.deepEqual(onDisk.write_grants, []);
  assert.deepEqual(onDisk.bash_allow, []);
  assert.equal(onDisk.nestable, false);
  assert.equal(onDisk.opencode_provider, null);
});

test("--trust keeps the grants, and still reports exactly what it accepted", () => {
  const root = projectRoot();
  const source = foreignProject({ ...BASE, bash_allow: ["git status"], nestable: true });

  const imported = importCatalogEntry(root, CFG, source, { trust: true });
  assert.deepEqual(imported.dropped, []);
  // Reporting only `dropped` would make a trusted import of a shell grant look identical
  // to a trusted import of nothing — the one case where silence is most dangerous.
  assert.deepEqual(imported.privileged.map((p) => p.field).sort(), ["bash_allow", "nestable"]);
  const onDisk = JSON.parse(readFileSync(path.join(imported.dir, "manifest.json"), "utf8"));
  assert.deepEqual(onDisk.bash_allow, ["git status"]);
  assert.equal(onDisk.nestable, true);
});

test("an untrusted import cannot select a host-bound function capability", () => {
  const root = projectRoot();
  const source = foreignProject({
    ...BASE,
    executor: "function",
    capability: { id: "host.trusted-operation" },
  });

  const imported = importCatalogEntry(root, CFG, source);
  assert.deepEqual(imported.dropped.map((d) => d.field).sort(), ["capability", "executor"]);
  assert.equal(imported.manifest.executor, null);
  assert.equal(imported.manifest.capability, null);
});

test("--trust explicitly preserves and reports a host-bound function capability", () => {
  const root = projectRoot();
  const source = foreignProject({
    ...BASE,
    executor: "function",
    capability: { id: "host.trusted-operation" },
  });

  const imported = importCatalogEntry(root, CFG, source, { trust: true });
  assert.deepEqual(imported.privileged.map((d) => d.field).sort(), ["capability", "executor"]);
  assert.equal(imported.manifest.executor, "function");
  assert.deepEqual(imported.manifest.capability, { id: "host.trusted-operation" });
});

test("web survives an untrusted import, and is reported rather than dropped", () => {
  const root = projectRoot();
  const imported = importCatalogEntry(root, CFG, foreignProject({ ...BASE, web: true }));

  assert.deepEqual(imported.dropped, []);
  assert.deepEqual(imported.notable, ["web"]);
  assert.equal(JSON.parse(readFileSync(path.join(imported.dir, "manifest.json"), "utf8")).web, true);
});

test("a symlink anywhere in the tree stops the import", () => {
  const source = foreignProject(BASE);
  symlinkSync("/etc", path.join(source, "skills", "escape"));

  assert.throws(() => importCatalogEntry(projectRoot(), CFG, source), /refusing to import a symlink/);
});

test("importing under a new name rewrites the manifest to match its folder", () => {
  const root = projectRoot();
  const imported = importCatalogEntry(root, CFG, foreignProject(BASE), { as: "local-scout" });

  assert.equal(imported.name, "local-scout");
  assert.equal(imported.manifest.name, "local-scout");
  assert.ok(existsSync(entryDir(root, "local-scout")));
  // The rename must survive validation, which requires manifest.name === folder name.
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "local-scout"));
});

test("an import refuses to silently replace an entry that is already there", () => {
  const root = projectRoot();
  const existing = saveProject(root, "scout");
  createProjectSkill(existing, "old", { description: "Use for the old project." });
  const source = foreignProject(BASE);

  assert.throws(() => importCatalogEntry(root, CFG, source), /already exists/);
  assert.doesNotThrow(() => importCatalogEntry(root, CFG, source, { force: true }));
  assert.match(readFileSync(path.join(entryDir(root, "scout"), "AGENTS.md"), "utf8"), /You are the imported one/);
  assert.ok(!existsSync(path.join(entryDir(root, "scout"), "skills", "old", "SKILL.md")));
});

test("a failed forced import preserves the existing entry", () => {
  const root = projectRoot();
  const existing = saveProject(root, "scout");
  writeProjectFile(existing, "AGENTS.md", "ORIGINAL PERSONA\n");
  const broken = foreignProject(BASE, { skill: false });
  writeFileSync(path.join(broken, "skills", "triage", "SKILL.md"), "# Missing description.\n");

  assert.throws(() => importCatalogEntry(root, CFG, broken, { force: true }), /has no description/);
  assert.equal(readFileSync(path.join(existing, "AGENTS.md"), "utf8"), "ORIGINAL PERSONA\n");
  assert.ok(!existsSync(path.join(existing, "skills", "triage", "SKILL.md")));
  assert.doesNotThrow(() => resolveCatalogEntry(root, CFG, "scout"));
});

test("a failed new import leaves no catalog entry behind", () => {
  const root = projectRoot();
  const broken = foreignProject({ ...BASE, name: "broken-new" }, { skill: false });
  writeFileSync(path.join(broken, "skills", "triage", "SKILL.md"), "# Missing description.\n");

  assert.throws(() => importCatalogEntry(root, CFG, broken), /has no description/);
  assert.ok(!existsSync(entryDir(root, "broken-new")));
});

test("a directory that is not an exported project is refused, and so is a broken one", () => {
  const root = projectRoot();
  assert.throws(() => importCatalogEntry(root, CFG, outside()), /not an exported alter project/);

  // A skill with no description passes manifest validation and fails project validation —
  // it must be caught at import rather than at the first spawn.
  const broken = foreignProject({ ...BASE, name: "mute" }, { skill: false });
  writeFileSync(path.join(broken, "skills", "triage", "SKILL.md"), "# Skill\n\nNo frontmatter.\n");
  assert.throws(() => importCatalogEntry(root, CFG, broken), /has no description/);
});

test("exporting refuses to overwrite unless asked, and names a missing entry", () => {
  const root = projectRoot();
  saveProject(root, "scout");
  const destination = outside();

  const first = exportCatalogEntry(root, CFG, "scout", destination);
  writeFileSync(path.join(first.target, "stale.txt"), "stale\n");
  assert.throws(() => exportCatalogEntry(root, CFG, "scout", destination), /already exists/);
  assert.doesNotThrow(() => exportCatalogEntry(root, CFG, "scout", destination, { force: true }));
  assert.ok(!existsSync(path.join(first.target, "stale.txt")));
  assert.throws(() => exportCatalogEntry(root, CFG, "nope", destination), /catalog entry not found/);
});
