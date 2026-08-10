import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, mintAgentId, readAgentIdentity } from "./config.js";
import { TEMPLATE_SKILL } from "./paths.js";
import {
  PROFILE_OWNED_FILES,
  ensureMemoryIgnored,
  loadProfileManifest,
  resolveProfileDir,
  sha256,
  writeProfileMeta,
} from "./profile.js";
import { resolveRuntime } from "./runtime.js";
import { fail, iso } from "./util.js";

// Creating a mind used to be something only a human at a terminal could do: the logic sat
// in `mind init`, keyed off `process.cwd()`, and reported itself by printing. A host that
// wanted to create an agent had two bad options — spawn the CLI and parse its stderr, or
// reimplement the scaffolding and drift from it.
//
// So this is the same procedure with the terminal taken out of it: an explicit target
// directory instead of the working directory, a returned report instead of `console.log`,
// and no flag parsing. `mind init` is now a thin wrapper that prints what this returns,
// which keeps one implementation for both callers.

const copyFile = (src, dest) => {
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
};

export const isMindProject = (dir) => existsSync(path.join(dir, ".alters", "config.json"));

export const initMind = (
  dir,
  { name = null, source = null, profileDir = null, force = false, newIdentity = false, cliVersion = null, runtime: runtimeOverride } = {},
) => {
  const runtime = resolveRuntime(runtimeOverride);
  const target = path.resolve(dir);
  const resolvedProfileDir = profileDir ? path.resolve(profileDir) : resolveProfileDir(source);
  const manifest = loadProfileManifest(resolvedProfileDir);
  // Read before anything is written — the config is rewritten below, so this is the only
  // point at which the *previous* identity is still observable.
  const recorded = readAgentIdentity(target);

  if (isMindProject(target) && !force) {
    fail(`${target} is already a mind project (.alters/config.json exists). Pass force to reinitialize.`);
  }
  mkdirSync(target, { recursive: true });

  // Root AGENTS.md
  const agentsSrc = path.join(resolvedProfileDir, "AGENTS.md");
  if (existsSync(agentsSrc)) copyFile(agentsSrc, path.join(target, "AGENTS.md"));

  // Root harness config
  const opencodeSrc = path.join(resolvedProfileDir, "opencode.jsonc");
  if (existsSync(opencodeSrc)) copyFile(opencodeSrc, path.join(target, "opencode.jsonc"));

  // Alter skill doc: the profile's own, or fall back to the engine's canonical copy.
  const profileSkill = path.join(resolvedProfileDir, "skills", "alter", "SKILL.md");
  const skillSrc = existsSync(profileSkill) ? profileSkill : TEMPLATE_SKILL;
  copyFile(skillSrc, path.join(target, ".opencode", "skills", "alter", "SKILL.md"));

  // .alters/config.json — profile overrides merged over engine defaults
  let configOverrides = {};
  const configSrc = path.join(resolvedProfileDir, "config.json");
  if (existsSync(configSrc)) {
    try {
      configOverrides = JSON.parse(readFileSync(configSrc, "utf8"));
    } catch (e) {
      fail(`profile config.json is not valid JSON (${e.message})`);
    }
  }
  // Identity is resolved before the write and placed *after* the profile overrides, for
  // two reasons. A profile is a shared template, so an `agent_id` appearing in one would
  // clone a single identity into every mind initialized from it. And `force`
  // reinitializes an existing project: refreshing its files must not re-identify it,
  // which would orphan the memory it has already accumulated.
  //
  // `newIdentity` is the one sanctioned way past that rule, and it exists because
  // copying a mind copies its `agent_id`: the fork and the original then both claim one
  // identity, which `mind agents scan` reports as a conflict it cannot resolve on the
  // user's behalf. Re-identifying is deliberately explicit, because it cuts the fork off
  // from every memory record the original accumulated — which is the point of a fork, and
  // a disaster by accident. The legacy memory pin goes with it, or the "new" mind would
  // keep writing into the old one's namespace.
  const existing = newIdentity ? { agentId: null, name: null, memoryProjectId: null } : recorded;
  const config = {
    ...DEFAULT_CONFIG,
    ...configOverrides,
    agent_id: existing.agentId || mintAgentId(runtime),
    name: name || existing.name || path.basename(target),
    ...(existing.memoryProjectId ? { memory_project_id: existing.memoryProjectId } : {}),
    retry: { ...DEFAULT_CONFIG.retry, ...(configOverrides.retry || {}) },
  };
  mkdirSync(path.join(target, ".alters"), { recursive: true });
  writeFileSync(path.join(target, ".alters", "config.json"), JSON.stringify(config, null, 2) + "\n");

  // .alters/catalog/*
  const catalogSrc = path.join(resolvedProfileDir, "catalog");
  if (existsSync(catalogSrc)) copyFile(catalogSrc, path.join(target, ".alters", config.catalog_dir || "catalog"));
  ensureMemoryIgnored(target);

  // package.json: ensure `mind` is a dependency, merge in any profile package.json fragment
  const pkgPath = path.join(target, "package.json");
  let pkg = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (e) {
      fail(`existing package.json is not valid JSON (${e.message})`);
    }
  } else {
    pkg = { name: path.basename(target), private: true, version: "0.0.0" };
  }
  pkg.dependencies = pkg.dependencies || {};
  // A host creating a mind has no version to declare, and inventing one would put a
  // dependency nobody can resolve into the manifest. The field is simply left alone.
  if (!pkg.dependencies.mind && cliVersion) pkg.dependencies.mind = "^" + cliVersion;
  const profilePkgSrc = path.join(resolvedProfileDir, "package.json");
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
    const p = path.join(target, rel);
    if (existsSync(p)) files[rel] = sha256(readFileSync(p));
  }
  writeProfileMeta(target, {
    profile: manifest.name,
    source: source ? path.resolve(source) : null,
    applied_at: iso(runtime.now()),
    files,
  });

  return {
    root: target,
    agentId: config.agent_id,
    name: config.name,
    profile: manifest.name,
    reinitialized: Boolean(recorded.agentId),
    identityPreserved: Boolean(existing.agentId),
    // What the previous identity was, when this call replaced it. The one thing a caller
    // must be able to report loudly: the mind no longer reads the memory it used to.
    previousAgentId: newIdentity && recorded.agentId && recorded.agentId !== config.agent_id ? recorded.agentId : null,
    config,
  };
};
