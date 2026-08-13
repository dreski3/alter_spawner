export const DEFAULT_SPAWN_OPTIONS = Object.freeze({
  name: null,
  description: null,
  model: null,
  prompt: null,
  images: [],
  readGrants: [],
  writeGrants: [],
  bashAllow: [],
  bashOnly: false,
  // A tool-less leaf with text output: no tools at all, and none of the boilerplate
  // that only makes sense to an agent that has some. See frontmatter.js.
  textOnly: false,
  nestable: false,
  timeout: null,
  rm: false,
  verbose: false,
  catalog: null,
  allowedCatalogs: null,
  // Which registered harness adapter runs this Alter. `null` means "whatever the
  // caller defaults to", which is `opencode`. See harness/adapter.js.
  executor: null,
  // For the `function` and `capability` executors: `{ id, input }` naming the host
  // capability to run and how the prompt is shaped into its input.
  capability: null,
  maxTokens: null,
  fallbackModel: null,
  promptPrefix: null,
  promptSuffix: null,
  webAccess: false,
  opencodeProvider: null,
  // Passed to `opencode run --variant`; providers commonly use this for reasoning
  // effort. Null preserves the model/provider default.
  opencodeVariant: null,
  outputContract: null,
});

export const createSpawnOptions = (overrides = {}) => ({
  ...DEFAULT_SPAWN_OPTIONS,
  ...overrides,
  readGrants: [...(overrides.readGrants || [])],
  images: [...(overrides.images || [])],
  writeGrants: [...(overrides.writeGrants || [])],
  bashAllow: [...(overrides.bashAllow || [])],
  allowedCatalogs: overrides.allowedCatalogs == null ? null : [...overrides.allowedCatalogs],
});
