import "./harness/opencode.js";
// Self-registering like opencode: it needs nothing a host must build, only the catalog
// and credentials opencode already keeps on disk. See harness/llm.js.
import "./harness/llm.js";

export { MindError, fail, normPath, sanitizeName } from "./util.js";
export { parseSpawnArgs } from "./parseArgs.js";
export { DEFAULT_SPAWN_OPTIONS, createSpawnOptions } from "./spawn-spec.js";
export {
  ALTER_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  GRAPH_RESULT_SCHEMA_VERSION,
  writeJsonAtomic,
  writeTextAtomic,
} from "./persistence.js";
export { validateOutputContract, checkOutputContract } from "./output-contract.js";
export { createRuntime, resolveRuntime } from "./runtime.js";
export { DEFAULT_CONFIG, findProjectRoot, requireProjectRoot, readConfig, kitDir } from "./config.js";
export {
  catalogDirPath,
  validateManifest,
  resolveCatalogEntry,
  applyCatalog,
  listCatalogEntries,
  saveCatalogEntry,
} from "./catalog.js";
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
export { runAlterGraph } from "./graph.js";
export { DEFAULT_MAX_EDGE_CHARS, renderGraphPrompt, validateGraph } from "./graph-spec.js";
export { withFileLock } from "./file-lock.js";
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
  inspectMemoryStorage,
  formatSearchOutcome,
  formatPutOutcome,
  formatStorageOutcome,
} from "./memory-client.js";
