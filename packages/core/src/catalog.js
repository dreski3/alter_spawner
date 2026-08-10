import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fail, iso, normPath, sanitizeName } from "./util.js";
import { kitDir } from "./config.js";
import { validateOutputContract } from "./output-contract.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import {
  PROJECT_AGENTS_FILE,
  PROJECT_SKILLS_DIR,
  scaffoldAlterProject,
  validateAlterProject,
} from "./alter-project.js";

export const catalogDirPath = (root, cfg) => path.join(kitDir(root), cfg.catalog_dir || "catalog");

export const validateManifest = (m, name) => {
  if (!m || typeof m !== "object") fail(`catalog entry "${name}": manifest.json is not an object.`);
  if (!m.name) fail(`catalog entry "${name}": manifest.json missing "name".`);
  if (m.name !== name) fail(`catalog entry "${name}": manifest.json "name" (${m.name}) does not match folder name.`);
  if (!m.description) fail(`catalog entry "${name}": manifest.json missing "description".`);
  if (m.max_tokens != null && !(Number.isInteger(m.max_tokens) && m.max_tokens > 0)) {
    fail(`catalog entry "${name}": max_tokens must be a positive integer or null.`);
  }
  if (m.nestable != null && typeof m.nestable !== "boolean") {
    fail(`catalog entry "${name}": nestable must be a boolean.`);
  }
  if (m.web != null && typeof m.web !== "boolean") {
    fail(`catalog entry "${name}": web must be a boolean.`);
  }
  if (m.bash_only != null && typeof m.bash_only !== "boolean") {
    fail(`catalog entry "${name}": bash_only must be a boolean.`);
  }
  if (m.text_only != null && typeof m.text_only !== "boolean") {
    fail(`catalog entry "${name}": text_only must be a boolean.`);
  }
  // Only the shape is checked here. Whether the name resolves to a registered
  // adapter is settled at spawn time by getHarness, which knows what exists.
  if (m.executor != null && (typeof m.executor !== "string" || !m.executor.trim())) {
    fail(`catalog entry "${name}": executor must be the name of a harness adapter.`);
  }
  // Likewise: whether this capability id is bound is a question for the host's
  // registry at run time. What is checkable here is that the entry is well formed.
  if (m.capability != null) {
    const c = m.capability;
    if (typeof c !== "object" || Array.isArray(c) || typeof c.id !== "string" || !c.id.trim()) {
      fail(`catalog entry "${name}": capability must be an object with an "id".`);
    }
    if (c.input != null && c.input !== "text" && c.input !== "json") {
      fail(`catalog entry "${name}": capability.input must be "text" or "json".`);
    }
  }
  // text_only is a claim about the whole shape of the Alter — text in, text out,
  // no capabilities of any kind — and its savings come precisely from dropping
  // everything a capability would need. Silently ignoring a contradictory grant
  // would hand back an Alter that cannot do what its manifest says it can, so
  // the combination is rejected at validation time rather than at runtime.
  if (m.text_only) {
    const conflicts = [
      m.bash_only && "bash_only",
      m.nestable && "nestable",
      m.web && "web",
      m.bash_allow?.length && "bash_allow",
      m.read_grants?.length && "read_grants",
      m.write_grants?.length && "write_grants",
      // A text_only Alter has no skill tool and scaffold does not even copy the
      // directory, so declaring skills here promises a capability that provably
      // will not exist at run time.
      m.skills_dir && "skills_dir",
    ].filter(Boolean);
    if (conflicts.length) {
      fail(`catalog entry "${name}": text_only cannot be combined with ${conflicts.join(", ")}.`);
    }
  }
  for (const key of ["read_grants", "write_grants", "bash_allow"]) {
    if (m[key] != null && !Array.isArray(m[key])) fail(`catalog entry "${name}": ${key} must be an array.`);
  }
  if (m.allowed_catalogs != null) {
    if (!Array.isArray(m.allowed_catalogs)) {
      fail(`catalog entry "${name}": allowed_catalogs must be an array of catalog names or null.`);
    }
    for (const allowed of m.allowed_catalogs) {
      if (typeof allowed !== "string" || !allowed.trim()) {
        fail(`catalog entry "${name}": allowed_catalogs entries must be non-empty catalog names.`);
      }
    }
  }
  // Both name a path inside the entry directory. Whether the path is actually there is
  // settled by validateAlterProject once the directory is known; what is checkable from
  // the manifest alone is that it is a relative path that stays inside the project.
  for (const key of ["agents_md_override", "skills_dir"]) {
    if (m[key] == null) continue;
    if (typeof m[key] !== "string" || !m[key].trim()) {
      fail(`catalog entry "${name}": ${key} must be a non-empty relative path or null.`);
    }
    if (path.isAbsolute(m[key]) || m[key].split(/[\\/]/).includes("..")) {
      fail(`catalog entry "${name}": ${key} must stay inside the entry directory (got "${m[key]}").`);
    }
  }
  if (m.opencode_provider != null) {
    if (
      typeof m.opencode_provider !== "object" ||
      Array.isArray(m.opencode_provider) ||
      Object.keys(m.opencode_provider).length === 0
    ) {
      fail(`catalog entry "${name}": opencode_provider must be a non-empty object.`);
    }
    for (const [providerId, provider] of Object.entries(m.opencode_provider)) {
      if (!providerId || typeof provider !== "object" || provider === null || Array.isArray(provider)) {
        fail(`catalog entry "${name}": opencode_provider.${providerId || "(empty)"} must be an object.`);
      }
    }
  }
  validateOutputContract(m.output_contract, `catalog entry "${name}": output_contract`);
};

// Resolution seam: "local" is the only implemented source today. A future "mcp" source
// would return the same { dir, manifest } shape so callers never branch on source.type.
export const resolveCatalogEntry = (root, cfg, name) => {
  const dir = path.join(catalogDirPath(root, cfg), sanitizeName(name));
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`catalog entry not found: ${name}`);
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`catalog entry "${name}": manifest.json is not valid JSON (${e.message}).`);
  }
  validateManifest(m, name);
  validateAlterProject(dir, m, name);
  if (m.source && m.source.type === "mcp") {
    fail(`catalog entry "${name}" is MCP-backed; MCP resolution is not yet implemented.`);
  }
  return { dir, manifest: m };
};

// Precedence: any flag the caller explicitly passed wins; anything left at its
// parse-time default (null / empty array / false) is filled from the catalog manifest.
export const applyCatalog = (o, entry) => {
  const m = entry.manifest;
  if (o.description == null) o.description = m.description;
  if (o.model == null) o.model = m.model || null;
  if (o.fallbackModel == null) o.fallbackModel = m.fallback_model || null;
  if (o.maxTokens == null) o.maxTokens = m.max_tokens ?? null;
  if (!o.nestable) o.nestable = !!m.nestable;
  if (!o.webAccess) o.webAccess = !!m.web;
  if (o.timeout == null) o.timeout = m.timeout_ms ?? null;
  if (o.readGrants.length === 0) o.readGrants = (m.read_grants || []).map(normPath);
  if (o.writeGrants.length === 0) o.writeGrants = (m.write_grants || []).map(normPath);
  if (!o.bashAllow || o.bashAllow.length === 0) o.bashAllow = m.bash_allow || [];
  if (!o.bashOnly) o.bashOnly = !!m.bash_only;
  if (!o.textOnly) o.textOnly = !!m.text_only;
  if (o.executor == null) o.executor = m.executor || null;
  if (o.capability == null) o.capability = m.capability ? { ...m.capability } : null;
  if (o.allowedCatalogs == null) o.allowedCatalogs = m.allowed_catalogs ? [...m.allowed_catalogs] : null;
  o.promptPrefix = o.promptPrefix ?? m.prompt_prefix ?? null;
  o.promptSuffix = o.promptSuffix ?? m.prompt_suffix ?? null;
  o.catalogEntryDir = entry.dir;
  o.catalogAgentsOverride = m.agents_md_override || null;
  o.catalogSkillsDir = m.skills_dir || null;
  if (o.opencodeProvider == null) o.opencodeProvider = m.opencode_provider || null;
  if (o.outputContract == null) o.outputContract = m.output_contract || null;
  o.catalogName = m.name;
};

export const listCatalogEntries = (root, cfg) => {
  const dir = catalogDirPath(root, cfg);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = entries.filter((n) => existsSync(path.join(dir, n, "manifest.json"))).sort();
  const out = [];
  for (const name of names) {
    try {
      out.push({
        name,
        // Carried so a caller that wants to show the entry's files does not have to
        // recompute the path from root+cfg and get the catalog_dir override wrong.
        dir: path.join(dir, name),
        manifest: JSON.parse(readFileSync(path.join(dir, name, "manifest.json"), "utf8")),
      });
    } catch {}
  }
  return out;
};

const manifestFromOptions = (name, o, runtime, { project = false } = {}) => ({
  name,
  description: o.description || "Single-use sandboxed Alter.",
  model: o.model || null,
  fallback_model: o.fallbackModel || null,
  max_tokens: o.maxTokens ?? null,
  nestable: !!o.nestable,
  web: !!o.webAccess,
  timeout_ms: o.timeout ?? null,
  read_grants: o.readGrants || [],
  write_grants: o.writeGrants || [],
  bash_allow: o.bashAllow || [],
  bash_only: !!o.bashOnly,
  text_only: !!o.textOnly,
  executor: o.executor || null,
  capability: o.capability ? { ...o.capability } : null,
  allowed_catalogs: o.allowedCatalogs ? [...o.allowedCatalogs] : null,
  prompt_prefix: o.promptPrefix ?? null,
  prompt_suffix: o.promptSuffix ?? null,
  agents_md_override: project ? PROJECT_AGENTS_FILE : null,
  skills_dir: project ? PROJECT_SKILLS_DIR : null,
  opencode_provider: o.opencodeProvider || null,
  output_contract: o.outputContract || null,
  source: { type: "local", ref: null },
  created_at: iso(runtime.now()),
  created_from: o.createdFrom ?? null,
});

export const saveCatalogEntry = (
  root,
  cfg,
  name,
  o,
  { force = false, project = false, runtime: runtimeOverride } = {}
) => {
  const runtime = resolveRuntime(runtimeOverride);
  const sanitized = sanitizeName(name);
  const dir = path.join(catalogDirPath(root, cfg), sanitized);
  if (existsSync(dir) && !force) {
    fail(`catalog entry already exists: ${sanitized} (pass --force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  // Seeded before the manifest is written, so the manifest never points at files that
  // are not there yet — resolveCatalogEntry now treats a dangling reference as a hard
  // error rather than falling back to the stock persona.
  if (project) scaffoldAlterProject(dir, { description: o.description || "" });
  const manifest = manifestFromOptions(sanitized, o, runtime, { project });
  writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
  return dir;
};
