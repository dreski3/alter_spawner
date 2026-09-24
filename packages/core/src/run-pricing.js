import { splitModelRef } from "./providers.js";

export const snapshotPricing = (model, providers = {}) => {
  let providerId = null;
  let modelId = null;
  try {
    ({ providerId, modelId } = splitModelRef(model));
  } catch {}
  const provider = providers?.[providerId];
  const detail = provider?.models?.[modelId];
  const configured = detail?.cost ?? provider?.cost ?? null;
  const cost = configured && typeof configured === "object" ? {
    input_per_million: configured.input_per_million ?? null,
    output_per_million: configured.output_per_million ?? null,
    cache_read_per_million: configured.cache_read_per_million ?? null,
  } : null;
  return {
    source: cost ? "project_config" : "unavailable",
    provider_id: providerId,
    model_id: modelId,
    input: Array.isArray(detail?.input ?? provider?.input) ? [...(detail?.input ?? provider.input)] : null,
    capabilities: Array.isArray(detail?.capabilities ?? provider?.capabilities)
      ? [...(detail?.capabilities ?? provider.capabilities)] : null,
    residency: detail?.residency ?? provider?.residency ?? null,
    context_tokens: detail?.context_tokens ?? provider?.context_tokens ?? null,
    max_output_tokens: detail?.max_output_tokens ?? provider?.max_output_tokens ?? null,
    cost,
  };
};
