import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fail } from "./util.js";

// Configured direct providers are resolved first. Provider IDs absent from project
// configuration retain the original read-only OpenCode catalog/auth compatibility path.

const MODELS_CACHE = new Map();

export const DIRECT_PROVIDER_PROTOCOLS = Object.freeze([
  "openai-responses",
  "openai-compatible",
  "anthropic-messages",
  "gemini",
]);

const PROTOCOL_DEFAULTS = Object.freeze({
  "openai-responses": {
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "anthropic-messages": {
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
  },
});

export const modelsCatalogPath = (env = process.env) =>
  env.OPENCODE_MODELS_PATH || path.join(homedir(), ".cache", "opencode", "models.json");

export const authFilePath = (env = process.env) =>
  path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "auth.json");

// The catalog is ~3.5MB of JSON, so it is parsed once per path per process. It is a
// cache opencode refreshes on its own schedule; a stale copy costs a clear "unknown
// model" rather than a wrong answer.
export const loadModelsCatalog = (file) => {
  if (MODELS_CACHE.has(file)) return MODELS_CACHE.get(file);
  if (!existsSync(file)) {
    fail(
      `opencode's model catalog is not on disk at ${file} — run \`opencode models --refresh\` (or set OPENCODE_MODELS_PATH).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`opencode's model catalog is not valid JSON (${error.message}): ${file}`);
  }
  MODELS_CACHE.set(file, parsed);
  return parsed;
};

export const loadAuth = (file) => {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A malformed auth file is not fatal on its own — an env var or a public model may
    // still get us there — and its contents must never be echoed into an error.
    return {};
  }
};

// The catalog says which npm package opencode would load for a provider, which is a
// reliable statement about the wire protocol. These two speak plain OpenAI.
const OPENAI_COMPATIBLE_NPM = new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai"]);

// Providers whose base URL lives inside their AI SDK package rather than in the
// catalog's `api` field — 25 of 178 entries have no `api`, and these are the ones
// among them that are OpenAI-compatible anyway. Anything not listed here and without
// an `api` is refused rather than guessed at.
const FIRST_PARTY_BASE_URLS = Object.freeze({
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
});

export const splitModelRef = (ref) => {
  if (typeof ref !== "string" || !ref.includes("/")) {
    fail(`model must be "provider/model", got: ${ref ?? "(none)"}`);
  }
  const separator = ref.indexOf("/");
  return { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
};

const positiveIntegerOrNull = (value, label) => {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer or null.`);
  return value;
};

const configuredBaseUrl = (definition, protocol, providerId) => {
  const supplied = definition.base_url;
  const value = supplied || PROTOCOL_DEFAULTS[protocol]?.baseURL;
  if (!value) fail(`direct provider "${providerId}" must declare base_url for protocol "${protocol}".`);
  if (typeof value !== "string" || !value.trim()) fail(`direct provider "${providerId}" base_url must be a non-empty URL.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`direct provider "${providerId}" base_url is not a valid URL.`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    fail(`direct provider "${providerId}" base_url must use http or https.`);
  }
  return value.replace(/\/+$/, "");
};

const configuredApiKey = (definition, protocol, providerId, env) => {
  const defaultName = PROTOCOL_DEFAULTS[protocol]?.apiKeyEnv || null;
  const name = definition.api_key_env === undefined ? defaultName : definition.api_key_env;
  if (name === null) return null;
  if (typeof name !== "string" || !name.trim()) {
    fail(`direct provider "${providerId}" api_key_env must be a non-empty environment variable name or null.`);
  }
  if (!env[name]) fail(`no credential for direct provider "${providerId}" — set ${name}.`);
  return env[name];
};

export const resolveConfiguredLlmEndpoint = (modelRef, { providers = {}, env = process.env } = {}) => {
  const { providerId, modelId } = splitModelRef(modelRef);
  const definition = providers?.[providerId];
  if (definition == null) return null;
  if (typeof definition !== "object" || Array.isArray(definition)) {
    fail(`direct provider "${providerId}" must be an object.`);
  }
  const protocol = definition.protocol;
  if (!DIRECT_PROVIDER_PROTOCOLS.includes(protocol)) {
    fail(`direct provider "${providerId}" protocol must be one of: ${DIRECT_PROVIDER_PROTOCOLS.join(", ")}.`);
  }
  if (definition.models != null && (typeof definition.models !== "object" || Array.isArray(definition.models))) {
    fail(`direct provider "${providerId}" models must be an object or null.`);
  }
  const model = definition.models?.[modelId];
  if (definition.models && !model) {
    fail(`unknown model "${modelId}" for direct provider "${providerId}".`);
  }
  if (model != null && (typeof model !== "object" || Array.isArray(model))) {
    fail(`direct provider "${providerId}" model "${modelId}" must be an object.`);
  }
  const maxOutputTokens = positiveIntegerOrNull(
    model?.max_output_tokens ?? definition.max_output_tokens,
    `direct provider "${providerId}" max_output_tokens`,
  );
  const input = model?.input ?? definition.input ?? null;
  if (input != null && (!Array.isArray(input) || input.some((entry) => !["text", "image"].includes(entry)))) {
    fail(`direct provider "${providerId}" input must contain only "text" and "image".`);
  }
  return {
    providerId,
    modelId,
    protocol,
    baseURL: configuredBaseUrl(definition, protocol, providerId),
    apiKey: configuredApiKey(definition, protocol, providerId, env),
    maxOutputTokens,
    supportsImages: input == null ? null : input.includes("image"),
  };
};

const resolveBaseUrl = (provider, providerId) => {
  const compatible = OPENAI_COMPATIBLE_NPM.has(provider.npm);
  if (provider.api && compatible) return provider.api;
  if (FIRST_PARTY_BASE_URLS[providerId]) return FIRST_PARTY_BASE_URLS[providerId];
  if (provider.api && !compatible) {
    fail(
      `provider "${providerId}" speaks the ${provider.npm} protocol, which the llm executor does not implement — use the opencode executor for this model.`,
    );
  }
  fail(
    `provider "${providerId}" declares no base URL in opencode's catalog and is not a known OpenAI-compatible provider — use the opencode executor for this model.`,
  );
};

// A free model on opencode's own gateway authenticates with the literal key "public",
// which is why the project's default model works with no credential at all.
const isPublicZenModel = (providerId, model) =>
  providerId === "opencode" && model?.cost?.input === 0 && model?.cost?.output === 0;

const resolveApiKey = (provider, providerId, model, auth, env) => {
  const entry = auth[providerId];
  if (entry?.type === "api" && entry.key) return entry.key;
  if (entry && entry.type !== "api") {
    fail(
      `provider "${providerId}" is authenticated with ${entry.type}, whose token refresh the llm executor does not implement — use the opencode executor for this model.`,
    );
  }
  for (const name of provider.env || []) {
    if (env[name]) return env[name];
  }
  if (isPublicZenModel(providerId, model)) return "public";
  const names = (provider.env || []).join(" or ");
  fail(
    `no credential for provider "${providerId}" — run \`opencode auth login ${providerId}\`${names ? ` or set ${names}` : ""}.`,
  );
};

// OpenCode compatibility resolver. Pure: the caller supplies the already-loaded
// catalog and auth, which is also what makes it testable without touching real files.
export const resolveLlmEndpoint = (modelRef, { catalog, auth = {}, env = process.env } = {}) => {
  const { providerId, modelId } = splitModelRef(modelRef);
  const provider = catalog?.[providerId];
  if (!provider) {
    fail(`unknown provider "${providerId}" in opencode's model catalog — check the model name, or run \`opencode models --refresh\`.`);
  }
  const model = provider.models?.[modelId];
  if (!model) {
    fail(`unknown model "${modelId}" for provider "${providerId}" — run \`opencode models --refresh\` if it is new.`);
  }
  return {
    providerId,
    modelId,
    baseURL: resolveBaseUrl(provider, providerId).replace(/\/+$/, ""),
    apiKey: resolveApiKey(provider, providerId, model, auth, env),
    // The catalog knows each model's own output ceiling, which is a better default
    // than sending none and a better bound than whatever a catalog entry guessed.
    maxOutputTokens: model.limit?.output ?? null,
  };
};

export const resolveLlmEndpointFromDisk = (modelRef, env = process.env) =>
  resolveLlmEndpoint(modelRef, {
    catalog: loadModelsCatalog(modelsCatalogPath(env)),
    auth: loadAuth(authFilePath(env)),
    env,
  });

export const resolveDirectLlmEndpoint = (modelRef, { providers = {}, env = process.env } = {}) =>
  resolveConfiguredLlmEndpoint(modelRef, { providers, env }) || resolveLlmEndpointFromDisk(modelRef, env);
