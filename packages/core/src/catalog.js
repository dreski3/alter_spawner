import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fail, iso, normPath, sanitizeName } from "./util.js";
import { kitDir } from "./config.js";
import { validateOutputContract } from "./output-contract.js";
import { writeJsonAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";

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
      out.push({ name, manifest: JSON.parse(readFileSync(path.join(dir, name, "manifest.json"), "utf8")) });
    } catch {}
  }
  return out;
};

const manifestFromOptions = (name, o, runtime) => ({
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
  allowed_catalogs: o.allowedCatalogs ? [...o.allowedCatalogs] : null,
  prompt_prefix: o.promptPrefix ?? null,
  prompt_suffix: o.promptSuffix ?? null,
  agents_md_override: null,
  skills_dir: null,
  opencode_provider: o.opencodeProvider || null,
  output_contract: o.outputContract || null,
  source: { type: "local", ref: null },
  created_at: iso(runtime.now()),
  created_from: o.createdFrom ?? null,
});

export const saveCatalogEntry = (root, cfg, name, o, { force = false, runtime: runtimeOverride } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const sanitized = sanitizeName(name);
  const dir = path.join(catalogDirPath(root, cfg), sanitized);
  if (existsSync(dir) && !force) {
    fail(`catalog entry already exists: ${sanitized} (pass --force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  const manifest = manifestFromOptions(sanitized, o, runtime);
  writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
  return dir;
};
