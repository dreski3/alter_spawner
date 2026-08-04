import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_PROFILE_DIR = fileURLToPath(new URL("../profiles/default", import.meta.url));

export const resolveProfileDir = (sourceArg) => {
  if (!sourceArg) return DEFAULT_PROFILE_DIR;
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

export const ensureMemoryIgnored = (root) => {
  const file = path.join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const entry = ".alters/memory/";
  if (current.split(/\r?\n/).includes(entry)) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${current}${separator}${entry}\n`);
  return true;
};
