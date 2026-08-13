import "./harness/opencode.js";
// Self-registering like opencode: it needs nothing a host must build, only the catalog
// and credentials opencode already keeps on disk. See harness/llm.js.
import "./harness/llm.js";

export { MindError, fail, normPath, sanitizeName } from "./util.js";
export { parseSpawnArgs } from "./parseArgs.js";
export { DEFAULT_SPAWN_OPTIONS, createSpawnOptions } from "./spawn-spec.js";
export {
  MAX_IMAGE_FILES,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  validateImageFiles,
  modelImageSupport,
  validateImageModels,
} from "./image-input.js";
export {
  ALTER_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  GRAPH_RESULT_SCHEMA_VERSION,
  writeJsonAtomic,
  writeTextAtomic,
} from "./persistence.js";
export { validateOutputContract, checkOutputContract } from "./output-contract.js";
export { createRuntime, resolveRuntime } from "./runtime.js";
export {
  DEFAULT_CONFIG,
  findProjectRoot,
  requireProjectRoot,
  readConfig,
  kitDir,
  mintAgentId,
  readAgentIdentity,
  ensureAgentIdentity,
  resolveProjectId,
} from "./config.js";
export {
  catalogDirPath,
  validateManifest,
  resolveCatalogEntry,
  applyCatalog,
  listCatalogEntries,
  saveCatalogEntry,
  convertCatalogEntryToProject,
} from "./catalog.js";
export {
  PRIVILEGED_MANIFEST_FIELDS,
  exportCatalogEntry,
  importCatalogEntry,
} from "./catalog-transfer.js";
export {
  PROJECT_AGENTS_FILE,
  PROJECT_SKILLS_DIR,
  PROJECT_SKILL_FILE,
  MAX_PROJECT_FILE_BYTES,
  isAlterProject,
  isEditableProjectFile,
  inspectProjectTree,
  resolveProjectPath,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
  listProjectSkills,
  createProjectSkill,
  readSkillFrontmatter,
  scaffoldAlterProject,
  validateAlterProject,
  readAlterProject,
} from "./alter-project.js";
export { resolveId, scaffold } from "./scaffold.js";
export { buildFrontmatter, buildBody, buildAgentsMd } from "./frontmatter.js";
export { buildAttemptPlan, runWithRetries } from "./retry.js";
export { readAlterJson, resolveHome, listHomes, removeHome, writeResult } from "./homes.js";
export { spawnAlter, runExistingAlter, resolveEffectiveModel } from "./engine.js";
export {
  PRINCIPAL_DEPTH,
  isPrincipalProject,
  requirePrincipalProject,
  runPrincipalTurn,
} from "./principal.js";
export { describeAlterFailure, runAlterGraph } from "./graph.js";
export { DEFAULT_MAX_EDGE_CHARS, renderGraphPrompt, validateGraph } from "./graph-spec.js";
export { withFileLock } from "./file-lock.js";
export { withRefractoryPeriod, readRefractoryState, readSkipLog } from "./refractory.js";
export {
  OSCILLATION_SCHEMA_VERSION,
  BANDS,
  parseDuration,
  formatDuration,
  oscillationsDir,
  oscillationStateDir,
  oscillationStatePath,
  validateOscillation,
  readOscillations,
  readOscillation,
  writeOscillation,
  deleteOscillation,
  oscillationDueness,
  readCycleLog,
  runOscillation,
} from "./oscillation.js";
export { isMindProject, initMind } from "./init.js";
export {
  PROFILE_META_PATH,
  PROFILE_OWNED_FILES,
  defaultProfileDir,
  ensureMemoryIgnored,
  loadProfileManifest,
  readProfileMeta,
  resolveProfileDir,
  sha256,
  writeProfileMeta,
} from "./profile.js";
export {
  USAGE_SCHEMA_VERSION,
  resolveRange,
  folderTimestampMs,
  summarizeRunFolder,
  readSpendUsage,
  readOscillationActivity,
  readStorageUsage,
  readUsage,
} from "./usage.js";
export {
  BUILTIN_GRAPHS,
  daemonPolicyPath,
  createSpikeRunner,
  runDaemonTick,
  runDaemon,
} from "./daemon.js";
export {
  MIND_HOME_ENV,
  REGISTRY_SCHEMA_VERSION,
  mindHomeDir,
  registryPath,
  registryConfigPath,
  defaultWorkspaces,
  readRegistryConfig,
  writeRegistryConfig,
  addRegistryInput,
  removeRegistryInput,
  isMindRoot,
  discoverMindRoots,
  readRegistry,
  scanRegistry,
  ensureRegistry,
  touchMind,
  resolveMind,
  listMinds,
} from "./registry.js";
export {
  TREE_ID_ENV,
  TREE_LEDGER_ENV,
  TREE_NODE_ENV,
  TREE_LEDGER_SCHEMA_VERSION,
  treeLedgerPath,
  treeLimits,
  treeGuardsEnabled,
  admitTreeNode,
  releaseTreeNode,
  readTreeLedger,
  resolveTreeContext,
  withTreeEnv,
} from "./tree-budget.js";
export { ALTER_HOME_TEMPLATE_DIR, TEMPLATE_AGENT, TEMPLATE_SKILL } from "./paths.js";
export { registerHarness, getHarness, HARNESS_ADAPTERS } from "./harness/adapter.js";
// Not registered by default: a capability registry is host-built, and there is
// deliberately no path that loads one from a project directory. See harness/capability.js.
export { createFunctionExecutor, createCapabilityExecutor } from "./harness/capability.js";
export {
  authFilePath,
  loadAuth,
  loadModelsCatalog,
  modelsCatalogPath,
  resolveLlmEndpoint,
  resolveLlmEndpointFromDisk,
  splitModelRef,
} from "./providers.js";
export {
  VALID_APPROVAL_DECISIONS,
  CapabilityDeniedError,
  createCapabilityRegistry,
  createCapabilityApprovalSession,
  readCapabilityPolicy,
  hasCatalogGrant,
  grantCatalogCapability,
  writeCapabilityPolicy,
} from "./capabilities.js";
export {
  canonicalJson,
  normalizeJsonSchema,
  normalizeJsonValue,
  validateStructuredInput,
} from "./structured-data.js";
export {
  MEMORY_SCHEMA_VERSION,
  MEMORY_KINDS,
  memoryFilePath,
  createFileMemoryStore,
  createProjectMemoryStore,
} from "./memory.js";
export {
  SQLITE_MEMORY_SCHEMA_VERSION,
  sqliteMemoryFilePath,
  createSqliteMemoryStore,
  migrateFileMemoryStoreToSqlite,
} from "./sqlite-memory.js";
export {
  DEFAULT_MEMORY_CATALOG_CAPABILITIES,
  MEMORY_MUTATION_CAPABILITIES,
  createMemoryCapabilityDefinitions,
  createMemoryCapabilityRegistry,
} from "./memory-capabilities.js";
export {
  formatMemoryContext,
  runMemoryRecall,
  runMemoryCurator,
} from "./memory-workflows.js";
export {
  buildMemoryMaintenanceGraph,
  runMemoryMaintenanceGraph,
} from "./memory-maintenance.js";
export {
  CAPABILITY_URL_ENV,
  CAPABILITY_TOKEN_ENV,
  CapabilityUnavailableError,
  CapabilityRequestError,
  resolveCapabilityEndpoint,
  requestCapability,
  withoutCapabilityGrant,
} from "./capability-client.js";
export {
  searchMemory,
  putMemory,
  askMemoryAssistant,
  inspectMemoryStorage,
  formatSearchOutcome,
  formatPutOutcome,
  formatAssistantOutcome,
  formatStorageOutcome,
} from "./memory-client.js";
