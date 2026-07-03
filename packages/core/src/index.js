import "./harness/opencode.js";

export { MindError, fail, normPath, sanitizeName } from "./util.js";
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
export { ALTER_HOME_TEMPLATE_DIR, TEMPLATE_AGENT, TEMPLATE_SKILL } from "./paths.js";
export { registerHarness, getHarness, HARNESS_ADAPTERS } from "./harness/adapter.js";
