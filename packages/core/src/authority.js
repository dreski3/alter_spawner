import path from "node:path";
import { fail, sanitizeName } from "./util.js";

export const AUTHORITY_ENV = "ALTER_AUTHORITY";
export const AUTHORITY_SCHEMA_VERSION = 1;

const unique = (values) => [...new Set(values.filter(Boolean))];

const isUnder = (parent, child) => {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  return to === from || to.startsWith(from + path.sep);
};

const requireSubset = (kind, requested, allowed, { paths = false } = {}) => {
  for (const value of requested) {
    const permitted = paths
      ? allowed.some((parent) => isUnder(parent, value))
      : allowed.includes(value);
    if (!permitted) fail(`child authority exceeds parent ${kind}: ${value}`);
  }
};

const normalizeCatalogs = (catalogs) => {
  if (catalogs == null) return null;
  if (!Array.isArray(catalogs) || catalogs.some((name) => typeof name !== "string" || !name.trim())) {
    fail("invalid inherited authority: allowed_catalogs must be an array of names or null.");
  }
  return unique(catalogs.map(sanitizeName));
};

const normalizeAuthority = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid inherited authority: expected an object.");
  }
  if (value.schema_version !== AUTHORITY_SCHEMA_VERSION) {
    fail(`invalid inherited authority: unsupported schema version ${value.schema_version}.`);
  }
  const arrays = ["read_grants", "write_grants", "bash_allow", "models", "executors", "capabilities"];
  for (const key of arrays) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== "string" || !entry)) {
      fail(`invalid inherited authority: ${key} must be an array of non-empty strings.`);
    }
  }
  if (typeof value.web !== "boolean" || typeof value.nestable !== "boolean") {
    fail("invalid inherited authority: web and nestable must be booleans.");
  }
  if (!Number.isInteger(value.max_depth) || value.max_depth < 0) {
    fail("invalid inherited authority: max_depth must be a non-negative integer.");
  }
  return {
    schema_version: AUTHORITY_SCHEMA_VERSION,
    read_grants: unique(value.read_grants.map((grant) => path.resolve(grant))),
    write_grants: unique(value.write_grants.map((grant) => path.resolve(grant))),
    bash_allow: unique(value.bash_allow),
    web: value.web,
    nestable: value.nestable,
    models: unique(value.models),
    executors: unique(value.executors),
    capabilities: unique(value.capabilities),
    allowed_catalogs: normalizeCatalogs(value.allowed_catalogs),
    max_depth: value.max_depth,
  };
};

export const readInheritedAuthority = (environment) => {
  const encoded = environment?.[AUTHORITY_ENV];
  if (encoded == null || encoded === "") return null;
  try {
    return normalizeAuthority(JSON.parse(encoded));
  } catch (error) {
    if (error?.name === "MindError") throw error;
    fail(`invalid inherited authority: ${error?.message || "not valid JSON"}.`);
  }
};

const requestedModels = (o, attemptModels) => unique(attemptModels || [o.model, o.fallbackModel]);

const currentAuthority = (o, cfg, attemptModels, inherited = null) => ({
  schema_version: AUTHORITY_SCHEMA_VERSION,
  read_grants: unique((o.readGrants || []).map((grant) => path.resolve(grant))),
  write_grants: unique((o.writeGrants || []).map((grant) => path.resolve(grant))),
  bash_allow: unique(o.bashAllow || []),
  web: !!o.webAccess,
  nestable: !!o.nestable,
  models: requestedModels(o, attemptModels),
  executors: o.executor ? [o.executor] : [],
  capabilities: o.capability?.id ? [o.capability.id] : [],
  allowed_catalogs: o.allowedCatalogs == null ? null : unique(o.allowedCatalogs.map(sanitizeName)),
  max_depth: inherited ? Math.min(cfg.max_depth ?? 5, inherited.max_depth) : cfg.max_depth ?? 5,
});

const validateAgainst = (o, inherited, attemptModels) => {
  requireSubset("read grants", (o.readGrants || []).map((grant) => path.resolve(grant)), inherited.read_grants, { paths: true });
  requireSubset("write grants", (o.writeGrants || []).map((grant) => path.resolve(grant)), inherited.write_grants, { paths: true });
  requireSubset("bash permissions", o.bashAllow || [], inherited.bash_allow);
  requireSubset("models", requestedModels(o, attemptModels), inherited.models);
  requireSubset("executors", o.executor ? [o.executor] : [], inherited.executors);
  requireSubset("capabilities", o.capability?.id ? [o.capability.id] : [], inherited.capabilities);
  if (o.webAccess && !inherited.web) fail("child authority exceeds parent web access.");
  if (o.nestable && !inherited.nestable) fail("child authority exceeds parent nesting permission.");
  if (o.depth > inherited.max_depth) {
    fail(`parent authority max nesting depth (${inherited.max_depth}) reached; refusing depth ${o.depth}.`);
  }
  if (inherited.allowed_catalogs != null) {
    if (o.catalogName && !inherited.allowed_catalogs.includes(sanitizeName(o.catalogName))) {
      fail(`child authority excludes catalog entry: ${o.catalogName}`);
    }
    if (o.nestable && o.allowedCatalogs == null) {
      fail("child authority cannot remove the parent's catalog allowlist.");
    }
    if (o.nestable) {
      requireSubset("catalog entries", o.allowedCatalogs.map(sanitizeName), inherited.allowed_catalogs);
    }
  }
};

export const delegateAuthority = (o, cfg, runtime, { attemptModels = null } = {}) => {
  const inherited = readInheritedAuthority(runtime.env);
  if (inherited) validateAgainst(o, inherited, attemptModels);
  const current = currentAuthority(o, cfg, attemptModels, inherited);
  return {
    ...runtime,
    env: {
      ...runtime.env,
      [AUTHORITY_ENV]: JSON.stringify(current),
    },
  };
};

export const authorityMaxDepth = (cfg, runtime) => {
  const inherited = readInheritedAuthority(runtime.env);
  return inherited ? Math.min(cfg.max_depth ?? 5, inherited.max_depth) : cfg.max_depth ?? 5;
};
