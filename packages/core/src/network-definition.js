import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { kitDir } from "./config.js";
import { writeJsonAtomic } from "./persistence.js";
import { parseDuration } from "./oscillation.js";

export const NETWORK_SCHEMA_VERSION = 1;
export const NETWORK_ROLES = Object.freeze(["sensory", "internal", "active"]);
export const NETWORK_TRIGGER_TYPES = Object.freeze(["event", "oscillation", "manual"]);

const ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_TEXT = 4000;

const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const id = (value, label) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value.length > 100) {
    throw new Error(`${label} must contain lowercase letters, numbers, hyphens, or underscores`);
  }
  return value;
};

const text = (value, label, { required = false, max = MAX_TEXT } = {}) => {
  if (value == null || value === "") {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
};

const uniqueStrings = (value, label, { required = false, max = 100 } = {}) => {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return [];
  }
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} strings`);
  const normalized = value.map((entry, index) => text(entry, `${label}[${index}]`, { required: true, max: 200 }));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
  return normalized;
};

const normalizeInterface = (value, index) => {
  const source = object(value, `interfaces[${index}]`);
  const interfaceId = id(source.id, `interfaces[${index}].id`);
  return {
    id: interfaceId,
    name: text(source.name, `interface "${interfaceId}" name`, { required: true, max: 200 }),
    description: text(source.description, `interface "${interfaceId}" description`, { max: 2000 }),
    observations: uniqueStrings(source.observations, `interface "${interfaceId}" observations`),
    actions: uniqueStrings(source.actions, `interface "${interfaceId}" actions`),
  };
};

const normalizeTrigger = (value, componentId, index) => {
  const source = object(value, `component "${componentId}" trigger ${index}`);
  if (!NETWORK_TRIGGER_TYPES.includes(source.type)) {
    throw new Error(`component "${componentId}" trigger ${index} has unknown type ${JSON.stringify(source.type)}`);
  }
  if (source.type === "manual") return { type: "manual" };
  const field = source.type === "event" ? "event" : "oscillation";
  return { type: source.type, [field]: text(source[field], `component "${componentId}" trigger ${field}`, { required: true, max: 200 }) };
};

const normalizeBudget = (value, componentId) => {
  if (value == null) return null;
  const source = object(value, `component "${componentId}" budget`);
  const allowed = new Set(["max_tokens", "timeout_ms", "max_runs_per_hour"]);
  const unexpected = Object.keys(source).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`component "${componentId}" budget.${unexpected} is not allowed`);
  const integer = (field, minimum, maximum) => {
    const item = source[field];
    if (item == null) return null;
    if (!Number.isInteger(item) || item < minimum || item > maximum) {
      throw new Error(`component "${componentId}" budget.${field} must be an integer from ${minimum} to ${maximum}`);
    }
    return item;
  };
  return {
    max_tokens: integer("max_tokens", 1, 1_000_000),
    timeout_ms: integer("timeout_ms", 1, 86_400_000),
    max_runs_per_hour: integer("max_runs_per_hour", 1, 100_000),
  };
};

const normalizeComponent = (value, index) => {
  const source = object(value, `components[${index}]`);
  const componentId = id(source.id, `components[${index}].id`);
  if (!NETWORK_ROLES.includes(source.role)) {
    throw new Error(`component "${componentId}" role must be one of ${NETWORK_ROLES.join(", ")}`);
  }
  const targets = ["catalog", "graph", "capability"].filter((field) => source[field] != null);
  if (targets.length !== 1) throw new Error(`component "${componentId}" requires exactly one of catalog, graph, or capability`);
  const target = targets[0];
  if (source.role === "active" && target !== "capability") {
    throw new Error(`active component "${componentId}" must target a host capability`);
  }
  if (source.role !== "active" && target === "capability") {
    throw new Error(`${source.role} component "${componentId}" cannot target an active capability`);
  }
  const triggers = source.triggers == null ? [] : source.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0 || triggers.length > 100) {
    throw new Error(`component "${componentId}" requires 1–100 triggers`);
  }
  let refractory = null;
  if (source.refractory != null) {
    parseDuration(source.refractory, `component "${componentId}" refractory`);
    refractory = source.refractory;
  }
  return {
    id: componentId,
    role: source.role,
    description: text(source.description, `component "${componentId}" description`, { max: 2000 }),
    [target]: text(source[target], `component "${componentId}" ${target}`, { required: true, max: 200 }),
    triggers: triggers.map((trigger, triggerIndex) => normalizeTrigger(trigger, componentId, triggerIndex)),
    emits: uniqueStrings(source.emits, `component "${componentId}" emits`),
    refractory,
    budget: normalizeBudget(source.budget, componentId),
    enabled: source.enabled !== false,
  };
};

const validateReferences = (network, known = {}) => {
  const check = (items, value, label) => {
    if (items && !new Set(items).has(value)) throw new Error(`${label} references unknown ${value}`);
  };
  for (const component of network.components) {
    if (component.catalog) check(known.catalogs, component.catalog, `component "${component.id}" catalog`);
    if (component.graph) check(known.graphs, component.graph, `component "${component.id}" graph`);
    if (component.capability) check(known.capabilities, component.capability, `component "${component.id}" capability`);
    for (const trigger of component.triggers) {
      if (trigger.type === "oscillation") check(known.oscillations, trigger.oscillation, `component "${component.id}" oscillation`);
    }
  }
  if (network.ego?.catalog) check(known.catalogs, network.ego.catalog, "ego catalog");
};

export const validateNetworkDefinition = (value, { known = {}, source = "network definition" } = {}) => {
  const raw = object(value, source);
  const networkId = id(raw.id, `${source} id`);
  const interfaces = raw.interfaces == null ? [] : raw.interfaces;
  const components = raw.components == null ? [] : raw.components;
  if (!Array.isArray(interfaces) || interfaces.length > 50) throw new Error(`${source} interfaces must be an array of at most 50 entries`);
  if (!Array.isArray(components) || components.length > 500) throw new Error(`${source} components must be an array of at most 500 entries`);
  const normalizedInterfaces = interfaces.map(normalizeInterface);
  const normalizedComponents = components.map(normalizeComponent);
  for (const [label, entries] of [["interface", normalizedInterfaces], ["component", normalizedComponents]]) {
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${source} contains a duplicate ${label} id`);
  }
  let ego = null;
  if (raw.ego != null) {
    const value = object(raw.ego, `${source} ego`);
    ego = {
      enabled: value.enabled !== false,
      catalog: text(value.catalog, `${source} ego catalog`, { max: 200 }),
      contextual: value.contextual !== false,
      input_events: uniqueStrings(value.input_events, `${source} ego input_events`),
    };
    if (ego.enabled && !ego.catalog) throw new Error(`${source} enabled ego requires a catalog`);
  }
  const normalized = {
    schema_version: NETWORK_SCHEMA_VERSION,
    id: networkId,
    name: text(raw.name, `${source} name`, { required: true, max: 200 }),
    description: text(raw.description, `${source} description`, { max: 2000 }),
    ego,
    interfaces: normalizedInterfaces,
    components: normalizedComponents,
  };
  const observations = new Set(normalizedInterfaces.flatMap((entry) => entry.observations));
  const actions = new Set(normalizedInterfaces.flatMap((entry) => entry.actions));
  for (const component of normalized.components) {
    if (component.role === "sensory" && !component.triggers.some((trigger) => trigger.type === "event" && observations.has(trigger.event))) {
      throw new Error(`sensory component "${component.id}" must consume an observation declared by an interface`);
    }
    if (component.role === "active" && !actions.has(component.capability)) {
      throw new Error(`active component "${component.id}" capability must be declared as an interface action`);
    }
  }
  validateReferences(normalized, known);
  return normalized;
};

export const networkDefinitionPath = (root) => path.join(kitDir(root), "network.json");
export const networkVersionsDir = (root) => path.join(kitDir(root), "network-versions");
export const networkReleasesDir = (root) => path.join(kitDir(root), "network-releases");

export const readNetworkDefinition = (root) => {
  const file = networkDefinitionPath(root);
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const definition = validateNetworkDefinition(stored, { source: "stored network definition" });
  return {
    ...definition,
    revision: stored.revision,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
};

export const listNetworkVersions = (root) => {
  const dir = networkVersionsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^network-\d{6}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
};

export const listNetworkReleases = (root) => {
  const dir = networkReleasesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^release-\d{6}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
};

export const readActiveNetworkRelease = (root) => {
  const current = readNetworkDefinition(root);
  if (!current) return null;
  return listNetworkReleases(root).find((release) => release.revision === current.revision) || null;
};

export const applyNetworkDefinition = (root, value, { expectedRevision = null, known = {}, runtime } = {}) => {
  const current = readNetworkDefinition(root);
  if (expectedRevision != null && expectedRevision !== (current?.revision || 0)) {
    throw new Error(`network revision changed: expected ${expectedRevision}, found ${current?.revision || 0}`);
  }
  const normalized = validateNetworkDefinition(value, { known });
  const revision = (current?.revision || 0) + 1;
  const now = new Date(runtime?.now?.() ?? Date.now()).toISOString();
  const stored = {
    ...normalized,
    revision,
    created_at: current?.created_at || now,
    updated_at: now,
  };
  mkdirSync(networkVersionsDir(root), { recursive: true });
  writeJsonAtomic(path.join(networkVersionsDir(root), `network-${String(revision).padStart(6, "0")}.json`), stored);
  writeJsonAtomic(networkDefinitionPath(root), stored);
  return stored;
};

export const activateNetworkRelease = (
  root,
  value,
  { expectedRevision = null, known = {}, reconciliation = null, checks = [], resources = null, runtime } = {},
) => {
  const network = applyNetworkDefinition(root, value, { expectedRevision, known, runtime });
  const release = {
    release_id: `release-${String(network.revision).padStart(6, "0")}`,
    revision: network.revision,
    activated_at: network.updated_at,
    network,
    inventory: {
      catalogs: [...(known.catalogs || [])].sort(),
      graphs: [...(known.graphs || [])].sort(),
      oscillations: [...(known.oscillations || [])].sort(),
      capabilities: [...(known.capabilities || [])].sort(),
    },
    reconciliation,
    checks,
    resources,
  };
  mkdirSync(networkReleasesDir(root), { recursive: true });
  writeJsonAtomic(path.join(networkReleasesDir(root), `${release.release_id}.json`), release);
  return release;
};
