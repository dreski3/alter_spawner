import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, TEMPLATE_SKILL, fail } from "@mind/core";
import {
  PROFILE_OWNED_FILES,
  ensureMemoryIgnored,
  loadProfileManifest,
  resolveProfileDir,
  sha256,
  writeProfileMeta,
} from "../profile.js";

const copyFile = (src, dest) => {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
};

export const run = (argv, ctx) => {
  let source = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = argv[++i];
    else if (argv[i] === "--force") force = true;
    else fail("unknown flag: " + argv[i]);
  }

  const cwd = process.cwd();
  const profileDir = resolveProfileDir(source);
  const manifest = loadProfileManifest(profileDir);

  if (existsSync(path.join(cwd, ".alters", "config.json")) && !force) {
    fail("this directory is already a mind project (.alters/config.json exists). Pass --force to reinitialize.");
  }

  // Root AGENTS.md
  const agentsSrc = path.join(profileDir, "AGENTS.md");
  if (existsSync(agentsSrc)) copyFile(agentsSrc, path.join(cwd, "AGENTS.md"));

  // Root harness config
  const opencodeSrc = path.join(profileDir, "opencode.jsonc");
  if (existsSync(opencodeSrc)) copyFile(opencodeSrc, path.join(cwd, "opencode.jsonc"));

  // Alter skill doc: the profile's own, or fall back to the engine's canonical copy.
  const profileSkill = path.join(profileDir, "skills", "alter", "SKILL.md");
  const skillSrc = existsSync(profileSkill) ? profileSkill : TEMPLATE_SKILL;
  copyFile(skillSrc, path.join(cwd, ".opencode", "skills", "alter", "SKILL.md"));

  // .alters/config.json — profile overrides merged over engine defaults
  let configOverrides = {};
  const configSrc = path.join(profileDir, "config.json");
  if (existsSync(configSrc)) {
    try {
      configOverrides = JSON.parse(readFileSync(configSrc, "utf8"));
    } catch (e) {
      fail(`profile config.json is not valid JSON (${e.message})`);
    }
  }
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...configOverrides,
    retry: { ...DEFAULT_CONFIG.retry, ...(configOverrides.retry || {}) },
  };
  mkdirSync(path.join(cwd, ".alters"), { recursive: true });
  writeFileSync(path.join(cwd, ".alters", "config.json"), JSON.stringify(mergedConfig, null, 2) + "\n");

  // .alters/catalog/*
  const catalogSrc = path.join(profileDir, "catalog");
  if (existsSync(catalogSrc)) copyFile(catalogSrc, path.join(cwd, ".alters", mergedConfig.catalog_dir || "catalog"));
  ensureMemoryIgnored(cwd);

  // package.json: ensure `mind` is a dependency, merge in any profile package.json fragment
  const pkgPath = path.join(cwd, "package.json");
  let pkg = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (e) {
      fail(`existing package.json is not valid JSON (${e.message})`);
    }
  } else {
    pkg = { name: path.basename(cwd), private: true, version: "0.0.0" };
  }
  pkg.dependencies = pkg.dependencies || {};
  if (!pkg.dependencies.mind) pkg.dependencies.mind = "^" + ctx.cliVersion;
  const profilePkgSrc = path.join(profileDir, "package.json");
  if (existsSync(profilePkgSrc)) {
    try {
      const frag = JSON.parse(readFileSync(profilePkgSrc, "utf8"));
      pkg.dependencies = { ...pkg.dependencies, ...(frag.dependencies || {}) };
      pkg.devDependencies = { ...(pkg.devDependencies || {}), ...(frag.devDependencies || {}) };
    } catch (e) {
      fail(`profile package.json is not valid JSON (${e.message})`);
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Track profile-owned files by checksum so `mind update` can tell an
  // untouched copy (safe to refresh) from a user-edited one (skip + warn).
  const files = {};
  for (const rel of PROFILE_OWNED_FILES) {
    const p = path.join(cwd, rel);
    if (existsSync(p)) files[rel] = sha256(readFileSync(p));
  }
  writeProfileMeta(cwd, {
    profile: manifest.name,
    source: source ? path.resolve(source) : null,
    applied_at: new Date().toISOString(),
    files,
  });

  console.log(`initialized mind project (profile: ${manifest.name}) in ${cwd}`);
};
