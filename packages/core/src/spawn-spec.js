export const DEFAULT_SPAWN_OPTIONS = Object.freeze({
  name: null,
  description: null,
  model: null,
  prompt: null,
  readGrants: [],
  writeGrants: [],
  bashAllow: [],
  bashOnly: false,
  // A pure text-in/text-out leaf: no tools at all, and none of the boilerplate
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
  maxTokens: null,
  fallbackModel: null,
  promptPrefix: null,
  promptSuffix: null,
  webAccess: false,
  opencodeProvider: null,
  outputContract: null,
});

export const createSpawnOptions = (overrides = {}) => ({
  ...DEFAULT_SPAWN_OPTIONS,
  ...overrides,
  readGrants: [...(overrides.readGrants || [])],
  writeGrants: [...(overrides.writeGrants || [])],
  bashAllow: [...(overrides.bashAllow || [])],
  allowedCatalogs: overrides.allowedCatalogs == null ? null : [...overrides.allowedCatalogs],
});
