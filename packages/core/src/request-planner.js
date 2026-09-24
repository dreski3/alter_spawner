import { getHarness } from "./harness/adapter.js";
import { readInheritedAuthority } from "./authority.js";
import { loadModelsCatalog, modelsCatalogPath, resolveDirectLlmEndpoint, splitModelRef } from "./providers.js";
import { modelImageSupport } from "./image-input.js";
import { fail } from "./util.js";

const POLICY_KEYS = new Set([
  "strategy",
  "allowed_residencies",
  "required_context_tokens",
  "estimated_output_tokens",
  "max_estimated_cost_usd",
  "required_capabilities",
  "adviser",
]);

const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const nonnegativeNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const names = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() === item && item.length > 0);
const optionalNames = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() === item && item.length > 0);

export const validateRoutingPolicy = (policy, label = "routing") => {
  if (policy == null) return;
  if (typeof policy !== "object" || Array.isArray(policy)) fail(`${label} must be an object.`);
  const unknown = Object.keys(policy).find((key) => !POLICY_KEYS.has(key));
  if (unknown) fail(`${label}.${unknown} is not supported.`);
  if (policy.strategy != null && !["ordered", "lowest_cost"].includes(policy.strategy)) {
    fail(`${label}.strategy must be "ordered" or "lowest_cost".`);
  }
  if (policy.allowed_residencies != null && !names(policy.allowed_residencies)) {
    fail(`${label}.allowed_residencies must be a non-empty array of names.`);
  }
  if (policy.required_capabilities != null && !names(policy.required_capabilities)) {
    fail(`${label}.required_capabilities must be a non-empty array of names.`);
  }
  for (const key of ["required_context_tokens", "estimated_output_tokens"]) {
    if (policy[key] != null && !positiveInteger(policy[key])) fail(`${label}.${key} must be a positive integer.`);
  }
  if (policy.max_estimated_cost_usd != null && !nonnegativeNumber(policy.max_estimated_cost_usd)) {
    fail(`${label}.max_estimated_cost_usd must be a non-negative number.`);
  }
  if (policy.adviser != null) {
    const adviser = policy.adviser;
    if (typeof adviser !== "object" || Array.isArray(adviser) ||
      Object.keys(adviser).some((key) => !["id", "instructions", "criteria"].includes(key)) ||
      typeof adviser.id !== "string" || !adviser.id.trim() ||
      typeof adviser.instructions !== "string" || !adviser.instructions.trim() ||
      !adviser.criteria || typeof adviser.criteria !== "object" || Array.isArray(adviser.criteria) ||
      Object.keys(adviser.criteria).length === 0 ||
      Object.values(adviser.criteria).some((value) => typeof value !== "string" || !value.trim())) {
      fail(`${label}.adviser requires id, instructions, and a criteria map of candidate descriptions.`);
    }
  }
};

const metadataFor = (model, providers) => {
  const { providerId, modelId } = splitModelRef(model);
  const provider = providers?.[providerId] ?? {};
  if (typeof provider !== "object" || Array.isArray(provider)) fail(`routing metadata for "${model}": provider must be an object.`);
  if (provider.models != null && (typeof provider.models !== "object" || Array.isArray(provider.models))) {
    fail(`routing metadata for "${model}": models must be an object.`);
  }
  const detail = provider.models?.[modelId] ?? {};
  if (typeof detail !== "object" || Array.isArray(detail)) fail(`routing metadata for "${model}": model must be an object.`);
  const metadata = {
    input: detail.input ?? provider.input ?? null,
    context_tokens: detail.context_tokens ?? provider.context_tokens ?? null,
    residency: detail.residency ?? provider.residency ?? null,
    capabilities: detail.capabilities ?? provider.capabilities ?? null,
    cost: detail.cost ?? provider.cost ?? null,
    max_output_tokens: detail.max_output_tokens ?? provider.max_output_tokens ?? null,
  };
  if (metadata.input != null && (!Array.isArray(metadata.input) || metadata.input.some((value) => !["text", "image"].includes(value)))) {
    fail(`routing metadata for "${model}": input must contain only "text" and "image".`);
  }
  if (metadata.context_tokens != null && !positiveInteger(metadata.context_tokens)) {
    fail(`routing metadata for "${model}": context_tokens must be a positive integer.`);
  }
  if (metadata.max_output_tokens != null && !positiveInteger(metadata.max_output_tokens)) {
    fail(`routing metadata for "${model}": max_output_tokens must be a positive integer.`);
  }
  if (metadata.residency != null && (typeof metadata.residency !== "string" || !metadata.residency.trim())) {
    fail(`routing metadata for "${model}": residency must be a non-empty string.`);
  }
  if (metadata.capabilities != null && !optionalNames(metadata.capabilities)) {
    fail(`routing metadata for "${model}": capabilities must be an array of names.`);
  }
  if (metadata.cost != null && (
    typeof metadata.cost !== "object" || Array.isArray(metadata.cost) ||
    !nonnegativeNumber(metadata.cost.input_per_million) || !nonnegativeNumber(metadata.cost.output_per_million)
  )) {
    fail(`routing metadata for "${model}": cost needs non-negative input_per_million and output_per_million values.`);
  }
  return metadata;
};

const needsSandbox = (options) => !!(
  options.nestable || options.webAccess || options.bashOnly || options.bashAllow?.length ||
  options.readGrants?.length || options.writeGrants?.length || options.catalogSkillsDir
);

const imageCatalog = (environment) => {
  try {
    return loadModelsCatalog(modelsCatalogPath(environment));
  } catch {
    return null;
  }
};

const directEndpointAvailable = (model, providers, environment) => {
  try {
    resolveDirectLlmEndpoint(model, { providers, env: environment });
    return true;
  } catch {
    return false;
  }
};

export const planRequest = ({ options, config, prompt, defaultExecutor = "opencode", environment = process.env }) => {
  const policy = options.routing || {};
  validateRoutingPolicy(policy);
  if (!options.modelCandidates?.length) fail("routing requires modelCandidates.");
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(prompt || "", "utf8") / 4));
  const hasImages = !!options.images?.length;
  const catalog = hasImages && options.modelCandidates.some((candidate) => {
    const { providerId } = splitModelRef(candidate.model);
    return config.providers?.[providerId] == null;
  }) ? imageCatalog(environment) : null;
  const inherited = readInheritedAuthority(environment);
  const assessed = options.modelCandidates.map((candidate, index) => {
    const executor = candidate.executor || defaultExecutor;
    const adapter = getHarness(executor);
    const metadata = metadataFor(candidate.model, config.providers);
    const { providerId } = splitModelRef(candidate.model);
    const outputTokens = policy.estimated_output_tokens ?? (
      options.maxTokens != null && metadata.max_output_tokens != null
        ? Math.min(options.maxTokens, metadata.max_output_tokens)
        : options.maxTokens ?? metadata.max_output_tokens
    );
    const estimatedCost = metadata.cost && outputTokens != null
      ? (inputTokens * metadata.cost.input_per_million + outputTokens * metadata.cost.output_per_million) / 1_000_000
      : null;
    const requiredContext = Math.max(policy.required_context_tokens || 0, inputTokens + (outputTokens || 0));
    let reason = null;
    if (inherited && !inherited.models.includes(candidate.model)) reason = "model exceeds inherited authority";
    else if (inherited && !inherited.executors.includes(executor)) reason = "executor exceeds inherited authority";
    else if (options.modelCandidates.length > 1 && !["llm", "opencode", "grok", "codex"].includes(executor)) reason = "executor cannot safely fall back";
    else if (adapter.supportsRetry === false) reason = "executor does not support retries";
    else if (needsSandbox(options) && !adapter.needsAgentHome) reason = "request needs a sandbox";
    else if (executor === "llm" && !directEndpointAvailable(candidate.model, config.providers, environment)) reason = "direct endpoint is unavailable";
    else if (hasImages && (!adapter.supportsImages || metadata.input?.includes("image") === false ||
      (config.providers?.[providerId] == null && modelImageSupport(candidate.model, catalog) === false))) {
      reason = "image input is unsupported";
    } else if (metadata.input?.includes("text") === false) reason = "text input is unsupported";
    else if (policy.allowed_residencies && !policy.allowed_residencies.includes(metadata.residency)) reason = "residency is not allowed";
    else if (policy.estimated_output_tokens && metadata.max_output_tokens != null && policy.estimated_output_tokens > metadata.max_output_tokens) {
      reason = "output limit is too small";
    }
    else if (metadata.context_tokens != null && requiredContext > metadata.context_tokens) reason = "context limit is too small";
    else if (policy.required_context_tokens && metadata.context_tokens == null) reason = "context limit is unknown";
    else if (policy.required_capabilities?.some((capability) =>
      capability === "tools" ? !adapter.needsAgentHome || options.textOnly : !metadata.capabilities?.includes(capability)
    )) reason = "required capability is unavailable";
    else if ((policy.strategy === "lowest_cost" || policy.max_estimated_cost_usd != null) && estimatedCost == null) {
      reason = "estimated cost is unknown";
    } else if (policy.max_estimated_cost_usd != null && estimatedCost > policy.max_estimated_cost_usd) {
      reason = "estimated cost exceeds the limit";
    }
    return {
      candidate_id: candidate.id,
      model: candidate.model,
      executor,
      estimated_cost_usd: estimatedCost,
      eligible: reason == null,
      reason,
      index,
    };
  });
  const eligible = assessed.filter((item) => item.eligible);
  if (!eligible.length) {
    fail(`no eligible model candidate: ${assessed.map((item) => `${item.candidate_id}: ${item.reason}`).join("; ")}.`);
  }
  if (policy.strategy === "lowest_cost") {
    eligible.sort((a, b) => a.estimated_cost_usd - b.estimated_cost_usd || a.index - b.index);
  }
  if (policy.adviser) {
    for (const item of eligible) {
      if (!Object.hasOwn(policy.adviser.criteria, item.candidate_id)) {
        fail(`routing adviser is missing criteria for eligible candidate "${item.candidate_id}".`);
      }
    }
  }
  return {
    strategy: policy.strategy || "ordered",
    estimated_input_tokens: inputTokens,
    candidates: eligible.map(({ candidate_id, model, executor }) => ({ id: candidate_id, model, executor })),
    assessed: assessed.map(({ index, ...item }) => item),
  };
};
