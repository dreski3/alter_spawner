import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { requireProjectRoot, readConfig, catalogDirPath, TEMPLATE_SKILL, fail } from "@mind/core";
import {
  PROFILE_OWNED_FILES,
  ensureMemoryIgnored,
  loadProfileManifest,
  readProfileMeta,
  resolveProfileDir,
  sha256,
  writeProfileMeta,
} from "../profile.js";

const SKILL_REL = path.join(".opencode", "skills", "alter", "SKILL.md");

const srcForOwnedFile = (profileDir, rel) => {
  if (rel === SKILL_REL) {
    const p = path.join(profileDir, "skills", "alter", "SKILL.md");
    return existsSync(p) ? p : TEMPLATE_SKILL;
  }
  return path.join(profileDir, rel);
};

export const run = (argv) => {
  let source = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = argv[++i];
    else fail("unknown flag: " + argv[i]);
  }

  const root = requireProjectRoot();
  const profileDir = resolveProfileDir(source);
  const manifest = loadProfileManifest(profileDir);
  const meta = readProfileMeta(root) || { files: {} };

  const newFiles = { ...meta.files };
  const refreshed = [];
  const skippedModified = [];
  const skippedUntracked = [];

  for (const rel of PROFILE_OWNED_FILES) {
    const src = srcForOwnedFile(profileDir, rel);
    if (!existsSync(src)) continue;
    const destPath = path.join(root, rel);
    const recordedHash = meta.files?.[rel];
    if (existsSync(destPath)) {
      if (!recordedHash) {
        skippedUntracked.push(rel);
        continue;
      }
      const currentHash = sha256(readFileSync(destPath));
      if (currentHash !== recordedHash) {
        skippedModified.push(rel);
        continue;
      }
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    cpSync(src, destPath);
    newFiles[rel] = sha256(readFileSync(src));
    refreshed.push(rel);
  }

  // New catalog entries from the profile are added; existing ones are never touched.
  const cfg = readConfig(root);
  const catalogDest = catalogDirPath(root, cfg);
  const catalogSrc = path.join(profileDir, "catalog");
  const added = [];
  if (existsSync(catalogSrc)) {
    mkdirSync(catalogDest, { recursive: true });
    for (const name of readdirSync(catalogSrc)) {
      const destEntry = path.join(catalogDest, name);
      if (!existsSync(destEntry)) {
        cpSync(path.join(catalogSrc, name), destEntry, { recursive: true });
        added.push(name);
      }
    }
  }
  ensureMemoryIgnored(root);

  writeProfileMeta(root, {
    profile: manifest.name,
    source: source ? path.resolve(source) : meta.source ?? null,
    applied_at: new Date().toISOString(),
    files: newFiles,
  });

  console.log(`updated from profile: ${manifest.name}`);
  console.log(refreshed.length ? `  refreshed: ${refreshed.join(", ")}` : "  refreshed: (none)");
  if (skippedModified.length) console.log(`  skipped (locally modified): ${skippedModified.join(", ")}`);
  if (skippedUntracked.length) console.log(`  skipped (untracked, exists already): ${skippedUntracked.join(", ")}`);
  console.log(added.length ? `  added catalog entries: ${added.join(", ")}` : "  added catalog entries: (none)");
};
