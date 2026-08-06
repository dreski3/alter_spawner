import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

// A profile is a template for a new mind — its AGENTS.md, its harness config, the catalog
// it starts with. The files ship with the CLI package rather than with core, because they
// are the shipped *product's* opinion and core has no opinion; but `initMind` lives in
// core so a host can create a mind without spawning a CLI, which means core has to be able
// to find them. Hence a probe rather than one constant: the two layouts below are the only
// two that exist, and the packaged one is checked first because it is the one users run.
//
//   dist:  dist/core/src/profile.js  ->  dist/profiles/default
//   repo:  packages/core/src/profile.js -> packages/cli/profiles/default
const PROFILE_DIR_CANDIDATES = ["../../profiles/default", "../../cli/profiles/default"];

export const defaultProfileDir = () => {
  for (const candidate of PROFILE_DIR_CANDIDATES) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path.join(dir, "profile.json"))) return dir;
  }
  // Reported rather than returned-as-null: every caller needs *a* profile, and a missing
  // one is a broken installation, not a condition to handle.
  throw new Error("no default profile found — expected one of: " + PROFILE_DIR_CANDIDATES.join(", "));
};

export const resolveProfileDir = (sourceArg) => {
  if (!sourceArg) return defaultProfileDir();
  const dir = path.resolve(sourceArg);
  if (!existsSync(dir)) throw new Error(`--source path not found: ${sourceArg}`);
  return dir;
};

export const loadProfileManifest = (profileDir) => {
  try {
    return JSON.parse(readFileSync(path.join(profileDir, "profile.json"), "utf8"));
  } catch {
    return { name: path.basename(profileDir), description: null };
  }
};

// Files a profile "owns" at the project root — tracked by checksum in
// `.alters/.mind-profile.json` so `mind update` can tell an untouched,
// safely-refreshable copy from one the user has since edited by hand.
export const PROFILE_OWNED_FILES = ["AGENTS.md", "opencode.jsonc", path.join(".opencode", "skills", "alter", "SKILL.md")];

export const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

export const PROFILE_META_PATH = (root) => path.join(root, ".alters", ".mind-profile.json");

export const readProfileMeta = (root) => {
  try {
    return JSON.parse(readFileSync(PROFILE_META_PATH(root), "utf8"));
  } catch {
    return null;
  }
};

export const writeProfileMeta = (root, meta) => {
  writeFileSync(PROFILE_META_PATH(root), JSON.stringify(meta, null, 2) + "\n");
};

// Run-local state that accumulates and belongs to nobody's history: the memory store,
// one ledger per tree of Alters, and — under `state/` — when each rhythm last fired, the
// ticks it skipped, and the grants that authorize it to act unattended. Oscillation
// *definitions* live in `.alters/oscillations/` and are authored config, so they stay
// tracked; only their state is ignored.
const IGNORED_KIT_PATHS = [".alters/memory/", ".alters/trees/", ".alters/state/"];

export const ensureMemoryIgnored = (root) => {
  const file = path.join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missing = IGNORED_KIT_PATHS.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${current}${separator}${missing.join("\n")}\n`);
  return true;
};
