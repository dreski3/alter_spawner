export type AlterTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  total: number;
};

export type Runtime = {
  now(): number;
  randomId(length?: number): string;
  env: Record<string, string | undefined>;
  /** This process's pid, recorded in the tree ledger and the refractory lock so a crashed holder's slot can be reclaimed. */
  pid: number;
  isProcessAlive(pid: number): boolean;
};

export type SpawnOptions = {
  name: string | null;
  description: string | null;
  model: string | null;
  prompt: string | null;
  readGrants: string[];
  writeGrants: string[];
  bashAllow: string[];
  bashOnly?: boolean;
  /** A pure text-in/text-out leaf: no tools, and none of the boilerplate that presumes some. */
  textOnly?: boolean;
  /** Which registered harness adapter runs this Alter. Null means the caller's default. */
  executor?: string | null;
  /** For the `function` and `capability` executors: which host capability to run, and how the prompt becomes its input. */
  capability?: { id: string; input?: "text" | "json" } | null;
  nestable: boolean;
  timeout: number | null;
  rm: boolean;
  verbose: boolean;
  catalog: string | null;
  allowedCatalogs: string[] | null;
  maxTokens: number | null;
  fallbackModel: string | null;
  promptPrefix: string | null;
  promptSuffix: string | null;
  webAccess: boolean;
  opencodeProvider?: Record<string, unknown> | null;
  opencodeVariant?: string | null;
  outputContract?: OutputContract | null;
  /** Authoring-only, read by `saveCatalogEntry`: the project paths to record in the manifest. */
  agentsMdOverride?: string | null;
  skillsDir?: string | null;
  graphId?: string | null;
  dependsOn?: string[];
  [key: string]: unknown;
};

export type OutputContract =
  | { type: "nonempty"; trim?: boolean }
  | { type: "exact" | "prefix"; value: string; trim?: boolean }
  | { type: "regex"; pattern: string; flags?: string; trim?: boolean }
  | { type: "json"; trim?: boolean };

/**
 * Tool calls a run made, as persisted in result.json. Null rather than a zeroed rollup
 * when nothing counted: an executor without tools (`llm`, `function`) and a run predating
 * tool accounting both mean "unknown", which must not read as "none were called".
 */
export type AlterToolUsage = {
  calls: number;
  errors: number;
  by_name: Record<string, number>;
};

/** The same rollup as a harness reports it, before persistence renames `byName`. */
export type HarnessToolUsage = {
  calls: number;
  errors: number;
  byName: Record<string, number>;
};

export type AlterResponse = {
  tokens: AlterTokens;
  text: string;
  sessionID: string | null;
  steps: number;
  exitCode: number | null;
  killed: boolean;
  aborted?: boolean;
  ok: boolean;
  budget_exceeded: boolean;
  empty_output: boolean;
  contract_failed: boolean;
  contract_error: string | null;
  tools?: HarnessToolUsage | null;
  eventLog?: string | null;
  capability_error?: string | null;
};

export type AlterRuntimeEvent =
  | { type: "attempt.started"; attempt: number; model: string; reason: string }
  | { type: "output.delta"; attempt: number; model: string; delta: string; text: string; sessionID: string | null }
  | { type: "usage.updated"; attempt: number; model: string; tokens: AlterTokens; steps: number; sessionID: string | null };

export type AlterAttemptReason = "initial" | "retry_same_model" | "retry_fallback_model";

/** One entry of the attempt plan, as recorded in `result.json`'s `attempts`. */
export type AlterAttempt = {
  attempt: number;
  model: string;
  reason: AlterAttemptReason;
  ok: boolean;
  exit_code: number | null;
  killed: boolean;
  budget_exceeded: boolean;
  empty_output: boolean;
  contract_failed: boolean;
  contract_error: string | null;
  tokens: AlterTokens;
  tools: AlterToolUsage | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  event_log: string | null;
};

export type AlterResult = {
  id: string;
  ok: boolean;
  exit_code: number | null;
  killed: boolean;
  aborted: boolean;
  budget_exceeded: boolean;
  empty_output: boolean;
  contract_failed: boolean;
  contract_error: string | null;
  max_tokens: number | null;
  text: string;
  tokens: AlterTokens;
  steps: number;
  tools: AlterToolUsage | null;
  session_id: string | null;
  event_log: string | null;
  model: string;
  executor: string | null;
  catalog: string | null;
  depth: number;
  home: string;
  spawned_by: string;
  graph_id: string | null;
  depends_on: string[];
  output_contract: OutputContract | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  attempts: AlterAttempt[] | null;
};

export function parseSpawnArgs(argv: string[]): SpawnOptions;
export const DEFAULT_SPAWN_OPTIONS: Readonly<SpawnOptions>;
export function createSpawnOptions(overrides?: Partial<SpawnOptions>): SpawnOptions;
export const ALTER_SCHEMA_VERSION: number;
export const RESULT_SCHEMA_VERSION: number;
export const GRAPH_RESULT_SCHEMA_VERSION: number;
export function writeTextAtomic(file: string, content: string, options?: { mode?: number }): void;
export function writeJsonAtomic(file: string, value: unknown, options?: { mode?: number }): void;
export function createRuntime(overrides?: Partial<Runtime>): Runtime;
export function resolveRuntime(runtime?: Runtime): Runtime;

/** Throws a `MindError` with this message. Declared as `never` so callers narrow after it. */
export function fail(message: string): never;
/** Resolves a path, expanding a leading `~`. Passes through anything falsy. */
export function normPath(p: string): string;
export function sanitizeName(name: unknown): string;

export type MindConfig = {
  /** Who this mind is, as opposed to where it sits. Minted once and never derived from the path. */
  agent_id: string | null;
  /** The human handle. Mutable — renaming a mind must not re-identify it. */
  name: string | null;
  /** Escape hatch for a store that predates `agent_id`. Null on anything created since. */
  memory_project_id: string | null;
  default_model: string;
  max_depth: number;
  max_tree_nodes: number | null;
  max_tree_tokens: number | null;
  max_concurrent_alters: number | null;
  run_timeout_ms: number;
  catalog_dir: string;
  default_fallback_model: string | null;
  opencode_pure: boolean;
  opencode_event_log: boolean;
  retry: { same_harness_retries: number; fallback_retries: number };
  [key: string]: unknown;
};

/** The identity *as recorded*, with no defaults filled in — nulls mean "not set". */
export type AgentIdentity = {
  agentId: string | null;
  name: string | null;
  memoryProjectId: string | null;
};

export const DEFAULT_CONFIG: Readonly<MindConfig>;
/** Walks up from `startDir` for a directory containing `.alters/config.json`. Null if none. */
export function findProjectRoot(startDir?: string): string | null;
export function requireProjectRoot(startDir?: string): string;
export function kitDir(root: string): string;
export function readConfig(root: string): MindConfig;
export function mintAgentId(runtime?: Runtime): string;
export function readAgentIdentity(root: string): AgentIdentity;
/** Gives a root an identity if it lacks one, and is otherwise a no-op. The only writer of `agent_id`. */
export function ensureAgentIdentity(
  root: string,
  options?: { name?: string | null; memoryProjectId?: string | null; runtime?: Runtime },
): AgentIdentity & { minted: boolean };
export function resolveProjectId(root: string, explicit?: string | null): string;

export type CatalogManifest = {
  name: string;
  description: string;
  model?: string | null;
  fallback_model?: string | null;
  max_tokens?: number | null;
  nestable?: boolean;
  web?: boolean;
  timeout_ms?: number | null;
  read_grants?: string[];
  write_grants?: string[];
  bash_allow?: string[];
  bash_only?: boolean;
  text_only?: boolean;
  executor?: string | null;
  capability?: { id: string; input?: "text" | "json" } | null;
  allowed_catalogs?: string[] | null;
  prompt_prefix?: string | null;
  prompt_suffix?: string | null;
  agents_md_override?: string | null;
  skills_dir?: string | null;
  opencode_provider?: Record<string, unknown> | null;
  output_contract?: OutputContract | null;
  source?: { type: "local" | "mcp"; ref: string | null };
  created_at?: string;
  created_from?: string | null;
  [key: string]: unknown;
};

/** A resolved catalog entry. The shape is the resolution seam: `local` is the only source implemented. */
export type CatalogEntry = { dir: string; manifest: CatalogManifest };

export function catalogDirPath(root: string, cfg: MindConfig): string;
export function validateManifest(manifest: unknown, name: string): void;
export function resolveCatalogEntry(root: string, cfg: MindConfig, name: string): CatalogEntry;
/** Fills every option still at its parse-time default from the manifest. Mutates `options`. */
export function applyCatalog(options: SpawnOptions, entry: CatalogEntry): void;
export function listCatalogEntries(
  root: string,
  cfg: MindConfig,
): { name: string; dir: string; manifest: CatalogManifest }[];
export function saveCatalogEntry(
  root: string,
  cfg: MindConfig,
  name: string,
  options: SpawnOptions,
  /** `project: true` seeds AGENTS.md and skills/ and points the manifest at them. */
  saveOptions?: { force?: boolean; project?: boolean; runtime?: Runtime },
): string;

/** Seeds project files on an existing entry and records their paths. Changes no other field. */
export function convertCatalogEntryToProject(root: string, cfg: MindConfig, name: string): CatalogEntry;

// --- Alters authored as projects -------------------------------------------------
// The catalog entry directory is the source; `scaffold` compiles a copy into each run
// home. Every path below is relative to the entry directory and confined to it.

export const PROJECT_AGENTS_FILE: "AGENTS.md";
export const PROJECT_SKILLS_DIR: "skills";
export const PROJECT_SKILL_FILE: "SKILL.md";
export const MAX_PROJECT_FILE_BYTES: number;

export type ProjectFile = { path: string; bytes: number; editable: boolean };
export type ProjectSkill = { name: string; description: string; path: string; bytes: number };
export type AlterProject = {
  isProject: boolean;
  agentsPath: string | null;
  agents: string | null;
  skillsDir: string | null;
  skills: ProjectSkill[];
  files: ProjectFile[];
};

export function isAlterProject(manifest: CatalogManifest | null | undefined): boolean;
export function isEditableProjectFile(relPath: string): boolean;
/** Throws unless `relPath` resolves inside `entryDir`, following no link out of it. */
export function resolveProjectPath(entryDir: string, relPath: string, options?: { label?: string }): string;
export function listProjectFiles(entryDir: string): ProjectFile[];
export function readProjectFile(entryDir: string, relPath: string): string;
export function writeProjectFile(entryDir: string, relPath: string, content: string): string;
export function deleteProjectFile(entryDir: string, relPath: string): void;
export function listProjectSkills(entryDir: string, skillsDir?: string): ProjectSkill[];
export function createProjectSkill(
  entryDir: string,
  name: string,
  options?: { description?: string; skillsDir?: string },
): { name: string; path: string; file: string };
export function readSkillFrontmatter(text: string): Record<string, string>;
/** Seeds the project files. Never overwrites one that already exists. */
export function scaffoldAlterProject(
  entryDir: string,
  options?: { description?: string },
): { agents_md_override: string; skills_dir: string; description: string };
/** Checks that the files the manifest names are present and usable. */
export function validateAlterProject(dir: string, manifest: CatalogManifest, name: string): void;
export function readAlterProject(dir: string, manifest: CatalogManifest | null | undefined): AlterProject;

export function resolveId(name: string | null, runtime?: Runtime): string;
/** Claims a run folder and writes its `alter.json`. Returns the home. `agentFiles: false` skips everything only a harness reading the home off disk would open. */
export function scaffold(
  root: string,
  cfg: MindConfig,
  options: SpawnOptions,
  runtime?: Runtime,
  scaffoldOptions?: { agentFiles?: boolean },
): string;

export function buildFrontmatter(options: SpawnOptions): string;
export function buildBody(options: SpawnOptions): string;
export function buildAgentsMd(options: SpawnOptions): string;

/** Initial run, then same-model retries, then fallback-model retries if one is available. */
export function buildAttemptPlan(
  options: SpawnOptions,
  cfg: MindConfig,
  runtime?: Runtime,
  planOptions?: { allowRetries?: boolean },
): { model: string; reason: AlterAttemptReason }[];

export function runWithRetries(options: {
  options: SpawnOptions;
  config: MindConfig;
  home: string;
  prompt: string;
  timeout: number;
  depth: number;
  harnessName?: string;
  signal?: AbortSignal;
  onEvent?: (event: AlterRuntimeEvent) => void;
  pure?: boolean;
  recordEvents?: boolean;
  runtime?: Runtime;
  agent?: string;
  sessionId?: string | null;
  allowRetries?: boolean;
  /** A principal runs a user-authored agent definition, which must never be rewritten on a model swap. */
  regenerateAgentFile?: boolean;
}): Promise<{ res: AlterResponse; attempts: AlterAttempt[] }>;

export type AlterRecord = {
  schema_version: number;
  agent_id: string | null;
  id: string;
  name: string | null;
  description: string | null;
  model: string;
  executor: string | null;
  capability: { id: string; input?: "text" | "json" } | null;
  nestable: boolean;
  web: boolean;
  depth: number;
  parent_id: string | null;
  spawned_by: string;
  read_grants: string[];
  write_grants: string[];
  bash_allow: string[];
  bash_only: boolean;
  text_only: boolean;
  allowed_catalogs: string[] | null;
  catalog: string | null;
  max_tokens: number | null;
  fallback_model: string | null;
  graph_id: string | null;
  depends_on: string[];
  opencode_provider: Record<string, unknown> | null;
  output_contract: OutputContract | null;
  created_at: string;
  home: string;
};

/** The home's `alter.json`, or `{}` if it is missing or unreadable. */
export function readAlterJson(home: string): Partial<AlterRecord>;
/** Accepts a run-folder name, a logical id (most recent run wins), or an absolute path. */
export function resolveHome(root: string, arg: string): string;
/** `kitDirPath` is a `.alters`-shaped directory; homes live under its `runs/`. */
export function listHomes(kitDirPath: string): { id: string; folder: string; path: string }[];
export function removeHome(root: string, arg: string): string;
export function writeResult(
  root: string,
  home: string,
  options: SpawnOptions,
  res: AlterResponse,
  startedAt: string,
  endedAt: string,
  durationMs: number,
  attempts: AlterAttempt[] | null,
): AlterResult;

export type FileLockOptions = { timeoutMs?: number; staleMs?: number; pollMs?: number };
/** A mutex between processes, built on `O_EXCL`. Blocks until the deadline, then throws. */
export function withFileLock<T>(file: string, operation: () => T | Promise<T>, options?: FileLockOptions): Promise<T>;

export const ALTER_HOME_TEMPLATE_DIR: string;
export const TEMPLATE_AGENT: string;
export const TEMPLATE_SKILL: string;

export function spawnAlter(
  root: string,
  options: SpawnOptions,
  runOptions?: {
    createOnly?: boolean;
    harness?: string;
    signal?: AbortSignal;
    onEvent?: (event: AlterRuntimeEvent) => void;
    runtime?: Runtime;
  },
): Promise<
  | {
      home: string;
      created: true;
      depth: number;
      model: string;
      executor: string;
    }
  | {
      home: string;
      created: false;
      result: AlterResult;
      res: AlterResponse;
    }
>;

/** Re-runs an already-scaffolded home. An Alter may only re-run homes under its own `runs/`. */
export function runExistingAlter(
  root: string,
  homeArg: string,
  prompt: string,
  options?: {
    harness?: string | null;
    mindBinPath?: string | null;
    signal?: AbortSignal;
    onEvent?: (event: AlterRuntimeEvent) => void;
    runtime?: Runtime;
  },
): Promise<{ home: string; result: AlterResult; res: AlterResponse }>;

export function resolveEffectiveModel(options: SpawnOptions, cfg: MindConfig, runtime?: Runtime): string;

export const PRINCIPAL_DEPTH: -1;

export function isPrincipalProject(projectDir: string): boolean;
export function requirePrincipalProject(projectDir: string): string;

export type PrincipalTurn = {
  ok: boolean;
  text: string;
  sessionId: string | null;
  model: string;
  tokens: AlterTokens;
  steps: number;
  attempts: unknown[];
  aborted: boolean;
  budgetExceeded: boolean;
  emptyOutput: boolean;
  exitCode: number;
  durationMs: number;
  projectDir: string;
  res: AlterResponse;
};

export function runPrincipalTurn(
  projectDir: string,
  options: {
    prompt: string;
    sessionId?: string | null;
    model?: string | null;
    agent?: string | null;
    maxTokens?: number | null;
    timeout?: number | null;
    principalId?: string | null;
    harness?: string;
    // The persona for harnesses with no agent home to read one from — the `llm`
    // adapter's whole system prompt. Ignored by `opencode`, which reads the project's
    // own AGENTS.md instead.
    description?: string | null;
    signal?: AbortSignal;
    onEvent?: (event: AlterRuntimeEvent) => void;
    runtime?: Runtime;
  },
): Promise<PrincipalTurn>;

export type HarnessRunOptions = {
  timeout: number;
  depth: number;
  alterId: string;
  maxTokens: number | null;
  model: string;
  pure: boolean;
  recordEvents: boolean;
  attempt: number;
  signal?: AbortSignal;
  onEvent?: (event: AlterRuntimeEvent) => void;
  environment?: Record<string, string | undefined>;
  /** Which harness agent to run as. Defaults to an Alter home's generated `alter` agent. */
  agent?: string;
  /** Continues an existing harness session. An adapter with no session concept may ignore it. */
  sessionId?: string | null;
  title?: string;
  capability?: { id: string; input?: "text" | "json" } | null;
  catalogName?: string | null;
  description?: string | null;
};

export type HarnessAdapter = {
  run(home: string, prompt: string, options: HarnessRunOptions): Promise<AlterResponse>;
  /** False for an adapter that reads nothing off disk, so the scaffolder writes only the run record. Default true. */
  needsAgentHome?: boolean;
  /** False for a deterministic executor: one attempt, and no fallback-model tier. */
  supportsRetry?: boolean;
};

export function registerHarness(name: string, adapter: HarnessAdapter): void;
/** Throws with the registered names when `name` is not bound. */
export function getHarness(name: string): Readonly<HarnessAdapter>;
export const HARNESS_ADAPTERS: Map<string, Readonly<HarnessAdapter>>;

/** Runs a trusted operation with no approval prompt. Refuses any capability not declared `approval: "never"`. */
export function createFunctionExecutor(options: { registry: CapabilityRegistry }): Readonly<HarnessAdapter>;
/** The same execution path, routed through a host-built approval session. */
export function createCapabilityExecutor(options: {
  registry: CapabilityRegistry;
  createSession(context: {
    catalogId: string;
    signal?: AbortSignal;
    onEvent?: (event: CapabilityEvent) => void;
  }): Pick<CapabilityApprovalSession, "execute">;
}): Readonly<HarnessAdapter>;

export type AlterGraphNode = {
  id: string;
  prompt: string;
  depends_on?: string[];
  catalog?: string;
  description?: string;
  model?: string;
  fallbackModel?: string;
  maxTokens?: number;
  timeout?: number;
  readGrants?: string[];
  writeGrants?: string[];
  bashAllow?: string[];
  bashOnly?: boolean;
  nestable?: boolean;
  allowedCatalogs?: string[] | null;
  webAccess?: boolean;
  promptPrefix?: string;
  promptSuffix?: string;
  opencodeProvider?: Record<string, unknown>;
  opencodeVariant?: string;
  outputContract?: OutputContract;
  memory?: {
    recall?: boolean | { namespace?: string; query?: string };
    curate?: boolean | { namespace?: string };
  };
};

export function validateOutputContract(contract: OutputContract | null, label?: string): void;
export function checkOutputContract(
  text: string,
  contract: OutputContract | null,
): { ok: boolean; error: string | null };

export type AlterGraph = {
  id?: string;
  output?: string;
  max_edge_chars?: number | null;
  nodes: AlterGraphNode[];
};

/** Throws on a duplicate id, an unknown or self dependency, an undeclared `{{result:…}}`, or a cycle. */
export function validateGraph(graph: AlterGraph): {
  nodes: Map<string, AlterGraphNode & { depends_on: string[] }>;
  output: string;
};

/**
 * A dependency's whole result is pasted into its dependents' prompts, so in a deep pipeline
 * the payload compounds. 32k characters is the default ceiling; `max_edge_chars: null`
 * turns it off. Truncation is loud — a marker lands in the prompt and `onTruncate` fires.
 */
export const DEFAULT_MAX_EDGE_CHARS: number;
export function renderGraphPrompt(
  node: AlterGraphNode,
  records: Record<string, { result: { text: string } }>,
  options?: {
    maxEdgeChars?: number | null;
    onTruncate?: (event: { from: string; to: string; kept: number; total: number }) => void;
  },
): string;

export type GraphMemoryRuntime = {
  scope: MemoryScope;
  recallApprovals?: Pick<CapabilityApprovalSession, "execute">;
  curateApprovals?: Pick<CapabilityApprovalSession, "execute">;
  recall?: typeof runMemoryRecall;
  curate?: typeof runMemoryCurator;
};

/** Why an Alter run failed, in one actionable sentence. Reports a token-budget overrun ahead of any contract failure it caused. */
export function describeAlterFailure(result: AlterResult | AlterResponse): string;

export function runAlterGraph(
  root: string,
  graph: AlterGraph,
  options?: {
    harness?: string;
    signal?: AbortSignal;
    concurrency?: number;
    mindBinPath?: string;
    runtime?: Runtime;
    onProgress?: (result: Record<string, unknown>) => void;
    onEvent?: (event: AlterRuntimeEvent & { node: string; memory?: "recall" | "curate" }) => void;
    memory?: GraphMemoryRuntime | null;
  },
): Promise<{ home: string; result: Record<string, unknown> }>;

export type ApprovalDecision = "allow-once" | "allow-run" | "always-catalog" | "deny";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchema = {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")[];
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type CapabilityDefinitionBase = {
  id: string;
  name: string;
  description: string;
  risk?: string;
  approval?: "always" | "never";
  allowedDecisions?: ApprovalDecision[];
  executorVersion?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type CommandCapabilityDefinition = CapabilityDefinitionBase & {
  executors: Record<string, { file: string; args: string[] }>;
  inputSchema?: never;
  approvalPreview?: never;
  handler?: never;
};

export type StructuredCapabilityDefinition = CapabilityDefinitionBase & {
  executors?: never;
  inputSchema: JsonSchema;
  approvalPreview?: (input: JsonValue) => JsonValue;
  handler(context: { input: JsonValue; signal?: AbortSignal }): JsonValue | Promise<JsonValue>;
};

export type CapabilityDefinition = CommandCapabilityDefinition | StructuredCapabilityDefinition;

export type PublicCapability = {
  id: string;
  name: string;
  description: string;
  risk: string;
  approval: "always" | "never";
};

export type CapabilityApproval = {
  id: string;
  capabilityId: string;
  capabilityName: string;
  description: string;
  reason: string;
  risk: string;
  commandPreview: string;
  inputPreview: JsonValue;
  executionDigest: string;
  executorVersion: string;
  allowedDecisions: ApprovalDecision[];
  requestedAt: string;
};

export type CapabilityExecutionResult = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  value: JsonValue;
  outputBytes: number;
};

export type PreparedCapabilityInvocation = {
  capabilityId: string;
  platform: string;
  input: JsonValue;
  inputPreview: JsonValue;
  executionDigest: string;
  executorVersion: string;
  commandPreview: string;
};

export type CapabilityEvent =
  | { type: "capability.approval_required"; approval: CapabilityApproval }
  | { type: "capability.auto_approved"; capabilityId: string; executionDigest: string; decision: "allow-run" | "always-catalog" | "not-required" }
  | { type: "capability.approved" | "capability.denied"; capabilityId: string; executionDigest: string; decision: ApprovalDecision }
  | { type: "capability.execution_started"; capabilityId: string; commandPreview: string; executionDigest: string }
  | { type: "capability.execution_completed"; capabilityId: string; exitCode: number | null; durationMs: number; outputBytes: number }
  | { type: "capability.execution_failed"; capabilityId: string; exitCode: number | null; durationMs: number; error?: string };

export type CapabilityRegistry = {
  get(id: string): Readonly<CapabilityDefinition> | null;
  forCatalog(catalogId: string): Readonly<CapabilityDefinition>[];
  listPublic(): PublicCapability[];
  commandPreview(id: string, platform?: string): string;
  prepare(id: string, options?: { input?: JsonValue; platform?: string }): PreparedCapabilityInvocation;
  executePrepared(invocation: PreparedCapabilityInvocation, options?: { signal?: AbortSignal }): Promise<CapabilityExecutionResult>;
  execute(id: string, options?: { signal?: AbortSignal; platform?: string; input?: JsonValue }): Promise<CapabilityExecutionResult>;
};

export const VALID_APPROVAL_DECISIONS: ReadonlySet<ApprovalDecision>;
export function createCapabilityRegistry(options?: {
  definitions?: CapabilityDefinition[] | Record<string, CapabilityDefinition>;
  catalogCapabilities?: Record<string, string[]>;
}): CapabilityRegistry;

export type CapabilityApprovalSession = {
  authorize(capabilityId: string, options?: { reason?: string; platform?: string; input?: JsonValue }): Promise<{ decision: ApprovalDecision | "not-required" }>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<{ decision: ApprovalDecision }>;
  execute(capabilityId: string, options?: { reason?: string; platform?: string; input?: JsonValue }): Promise<CapabilityExecutionResult>;
  getPendingApproval(): CapabilityApproval | null;
  hasRunGrant(capabilityId: string): boolean;
};

export function createCapabilityApprovalSession(options: {
  registry: CapabilityRegistry;
  catalogId: string;
  signal?: AbortSignal;
  /** No one is watching: anything not already granted denies immediately rather than raising a card nobody will see. */
  unattended?: boolean;
  isPersistentlyApproved?: (request: { catalogId: string; capabilityId: string; executionDigest: string }) => boolean;
  persistApproval?: (decision: { catalogId: string; capabilityId: string; executionDigest: string; decision: "always-catalog"; approval: CapabilityApproval }) => void | Promise<void>;
  audit?: (decision: { catalogId: string; capabilityId: string; executionDigest: string; decision: ApprovalDecision; approval: CapabilityApproval }) => void | Promise<void>;
  onEvent?: (event: CapabilityEvent) => void;
  createId?: () => string;
  now?: () => string;
  clock?: () => number;
}): CapabilityApprovalSession;

export type CapabilityPolicy = { catalogGrants: Record<string, string[]> };
export function readCapabilityPolicy(file: string): CapabilityPolicy;
export function hasCatalogGrant(policy: CapabilityPolicy, catalogId: string, capabilityId: string): boolean;
export function grantCatalogCapability(policy: CapabilityPolicy, catalogId: string, capabilityId: string): CapabilityPolicy;
export function writeCapabilityPolicy(file: string, policy: CapabilityPolicy): void;

export function normalizeJsonValue(value: unknown, label?: string): JsonValue;
export function canonicalJson(value: unknown, label?: string): string;
export function normalizeJsonSchema(schema: unknown, label?: string): JsonSchema;
export function validateStructuredInput(schema: JsonSchema, value: unknown, label?: string): JsonValue;

export type MemoryKind = "fact" | "preference" | "decision" | "summary";

export type MemoryScope = {
  project: string;
  catalog?: string | null;
  conversation?: string | null;
  namespace?: string | null;
};

export type MemorySource = {
  runId?: string | null;
  catalogId?: string | null;
  messageIds?: string[];
};

export type MemoryInput = {
  kind?: MemoryKind;
  content: string;
  tags?: string[];
  source?: MemorySource;
  confidence?: number;
  expiresAt?: string | null;
  metadata?: Record<string, JsonValue>;
};

export type MemoryRecord = Required<Omit<MemoryInput, "source" | "metadata">> & {
  id: string;
  scope: Required<MemoryScope>;
  source: Required<MemorySource>;
  metadata: Record<string, JsonValue>;
  contentHash: string;
  logicalBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
  matchedTerms: string[];
};

export type MemoryMutation =
  | { operation: "put"; record: MemoryInput; scope: MemoryScope }
  | { operation: "update"; id: string; patch: Partial<MemoryInput>; scope: MemoryScope; expectedVersion?: number }
  | { operation: "delete"; id: string; scope: MemoryScope; expectedVersion?: number };

export type MemoryStore = {
  file: string;
  projectId: string;
  backend?: "json" | "sqlite";
  get(id: string, scope: MemoryScope): Promise<MemoryRecord | null>;
  search(query: string, scope: MemoryScope, options?: {
    limit?: number;
    kinds?: MemoryKind[];
    tags?: string[];
  }): Promise<MemorySearchResult[]>;
  list(scope: MemoryScope, options?: { limit?: number; includeExpired?: boolean }): Promise<MemoryRecord[]>;
  stats(scope: MemoryScope): Promise<MemoryStorageStats>;
  put(input: MemoryInput, scope: MemoryScope): Promise<MemoryRecord>;
  update(id: string, patch: Partial<MemoryInput>, scope: MemoryScope, options?: { expectedVersion?: number }): Promise<MemoryRecord>;
  delete(id: string, scope: MemoryScope, options?: { expectedVersion?: number }): Promise<MemoryRecord>;
  apply(mutations: MemoryMutation[]): Promise<MemoryRecord[]>;
  /** Reclaims unused storage store-wide. Never adds, changes, or removes a record. */
  compact(): Promise<MemoryCompactionResult>;
};

export type MemoryNamespaceStats = {
  records: number;
  activeRecords: number;
  logicalBytes: number;
};

export type MemoryStorageStats = {
  /** Bytes of live stored data. Falls when records are removed. */
  physicalBytes: number;
  /** Raw bytes on disk, including space the backend has not returned yet. */
  fileBytes: number;
  /** fileBytes - physicalBytes: what compact() would reclaim. Always 0 for JSON. */
  reclaimableBytes: number;
  logicalBytes: number;
  recordCount: number;
  activeRecordCount: number;
  expiredRecordCount: number;
  quotaBytes: number | null;
  quotaRatio: number | null;
  byNamespace: Record<string, MemoryNamespaceStats>;
};

export const MEMORY_SCHEMA_VERSION: number;
export const MEMORY_KINDS: readonly MemoryKind[];
export function memoryFilePath(root: string): string;
export function createFileMemoryStore(options: {
  file: string;
  projectId: string;
  runtime?: Runtime;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
}): MemoryStore;
export function createProjectMemoryStore(root: string, options: {
  backend: "sqlite";
  file?: string;
  projectId?: string;
  runtime?: Runtime;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
  busyTimeoutMs?: number;
  journalSizeLimitBytes?: number;
}): SqliteMemoryStore;
export function createProjectMemoryStore(root: string, options?: {
  backend?: "json" | "sqlite";
  file?: string;
  projectId?: string;
  runtime?: Runtime;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
  busyTimeoutMs?: number;
  journalSizeLimitBytes?: number;
}): MemoryStore;

export type MemoryCompactionResult = {
  physicalBytes: number;
  fileBytes: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
};

export type SqliteMemoryStore = MemoryStore & {
  backend: "sqlite";
  importRecords(records: MemoryRecord[]): Promise<{ imported: number; skipped: number; total: number }>;
  close(): void;
};

export const SQLITE_MEMORY_SCHEMA_VERSION: number;
export function sqliteMemoryFilePath(root: string): string;
export function createSqliteMemoryStore(options: {
  file: string;
  projectId: string;
  runtime?: Runtime;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
  busyTimeoutMs?: number;
  journalSizeLimitBytes?: number;
}): SqliteMemoryStore;
export function migrateFileMemoryStoreToSqlite(options: {
  sourceFile: string;
  destinationFile: string;
  projectId?: string;
  runtime?: Runtime;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
  busyTimeoutMs?: number;
  journalSizeLimitBytes?: number;
}): Promise<{
  imported: number;
  skipped: number;
  total: number;
  sourceFile: string;
  destinationFile: string;
  projectId: string;
  storage: MemoryCompactionResult;
}>;

export const DEFAULT_MEMORY_CATALOG_CAPABILITIES: Readonly<Record<string, readonly string[]>>;

/** The memory capabilities that mutate the store, and the only ones `grantable` accepts. */
export const MEMORY_MUTATION_CAPABILITIES: readonly string[];

/**
 * Memory mutations default to one-shot approval: `allow-once` or `deny`, so every
 * commit raises its own card. `grantable` widens the named mutations to accept
 * `allow-run` and `always-catalog` as well, which is what lets an unattended curate or
 * maintain cycle be approved once instead of once per pass. `true` means every
 * mutation. Reads are unaffected — they already accept every decision.
 */
export type MemoryCapabilityGrantable = boolean | string[];

export function createMemoryCapabilityDefinitions(options: {
  store: MemoryStore;
  grantable?: MemoryCapabilityGrantable;
}): CapabilityDefinition[];
export function createMemoryCapabilityRegistry(options: {
  store: MemoryStore;
  catalogCapabilities?: Record<string, string[]>;
  grantable?: MemoryCapabilityGrantable;
}): CapabilityRegistry;

export function formatMemoryContext(results: MemorySearchResult[]): string;
export type MemoryRecallPlan = { query: string; limit?: number; kinds?: MemoryKind[]; tags?: string[] };

export function runMemoryRecall(root: string, options: {
  /** Required unless `plan` is supplied: the request the planner Alter turns into a query. */
  prompt?: string;
  scope: MemoryScope;
  approvals: Pick<CapabilityApprovalSession, "execute">;
  /** A ready plan. Skips the planner Alter; validated against the same schema. */
  plan?: MemoryRecallPlan | null;
  catalog?: string;
  name?: string | null;
  model?: string | null;
  maxTokens?: number;
  mindBinPath?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: AlterRuntimeEvent) => void;
  runtime?: Runtime;
  harness?: string;
  spawn?: typeof spawnAlter;
}): Promise<{
  plan: MemoryRecallPlan;
  results: MemorySearchResult[];
  context: string;
  /** Null when a caller supplied the plan, because no planner Alter ran. */
  plannerHome: string | null;
  plannerResult: AlterResult | null;
}>;
export function runMemoryCurator(root: string, options: {
  content: string;
  scope: MemoryScope;
  source?: MemorySource;
  approvals: Pick<CapabilityApprovalSession, "execute">;
  catalog?: string;
  name?: string | null;
  model?: string | null;
  maxTokens?: number;
  mindBinPath?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: AlterRuntimeEvent) => void;
  runtime?: Runtime;
  harness?: string;
  spawn?: typeof spawnAlter;
}): Promise<{
  proposal: { records: MemoryInput[] };
  records: MemoryRecord[];
  curatorHome: string;
  curatorResult: AlterResult;
}>;

export type MemoryMaintenanceOperation =
  | { operation: "put"; record: MemoryInput }
  | { operation: "update"; id: string; patch: Partial<MemoryInput>; expectedVersion?: number }
  | { operation: "delete"; id: string; expectedVersion?: number };

export function buildMemoryMaintenanceGraph(options: {
  id?: string;
  scope: MemoryScope;
  limit?: number;
  includeExpired?: boolean;
  allowDeletes?: boolean;
  catalog?: string;
  model?: string | null;
  maxTokens?: number;
}): AlterGraph;

export function runMemoryMaintenanceGraph(root: string, options: {
  scope: MemoryScope;
  approvals?: Pick<CapabilityApprovalSession, "execute">;
  allowDeletes?: boolean;
  /** Request store-wide compaction after a committed plan that could free space. Default true. */
  compact?: boolean;
  graph?: {
    id?: string;
    limit?: number;
    includeExpired?: boolean;
    catalog?: string;
    model?: string | null;
    maxTokens?: number;
  };
  harness?: string | null;
  signal?: AbortSignal;
  mindBinPath?: string | null;
  runtime?: Runtime;
  onProgress?: (result: Record<string, unknown>) => void;
  onEvent?: (event: AlterRuntimeEvent) => void;
}): Promise<{
  home: string;
  result: Record<string, unknown>;
  plan: MemoryMaintenanceOperation[] | null;
  committed: boolean;
  records: MemoryRecord[];
  /** Null when compaction was not attempted, not needed, or declined. */
  storage: MemoryCompactionResult | null;
}>;

export const CAPABILITY_URL_ENV: "MIND_CAPABILITY_URL";
export const CAPABILITY_TOKEN_ENV: "MIND_CAPABILITY_TOKEN";

export type CapabilityEndpoint = { url: string; token: string };
export type CapabilityOutcome = {
  decision: "allow" | "deny" | string;
  value: JsonValue | null;
  error: string | null;
};

export function resolveCapabilityEndpoint(env?: Record<string, string | undefined>): CapabilityEndpoint;
export function withoutCapabilityGrant(env?: Record<string, string | undefined>): Record<string, string | undefined>;
export function requestCapability(capabilityId: string, options?: {
  input?: JsonValue;
  reason?: string | null;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CapabilityOutcome>;

export type MemoryClientOptions = {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export function searchMemory(options: MemoryClientOptions & {
  query: string;
  limit?: number | null;
  kinds?: MemoryKind[];
}): Promise<CapabilityOutcome & { results: MemorySearchResult[] }>;
export function putMemory(options: MemoryClientOptions & {
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  confidence?: number | null;
  expiresAt?: string | null;
}): Promise<CapabilityOutcome & { records: MemoryRecord[] }>;
export function inspectMemoryStorage(options?: MemoryClientOptions): Promise<CapabilityOutcome & { stats: MemoryStorageStats | null }>;
export function formatSearchOutcome(outcome: { decision: string; results: MemorySearchResult[] }): string;
export function formatPutOutcome(outcome: { decision: string; records: MemoryRecord[] }): string;
export function formatStorageOutcome(outcome: { decision: string; stats: MemoryStorageStats | null }): string;

/**
 * `max_depth` bounds how long a branch gets, not how many there are. A tree needs two
 * guards depth cannot give it: a ceiling on total work and one on work happening at once.
 * Neither can live in a process, so they share a ledger file serialized by `withFileLock`.
 */
export const TREE_ID_ENV: "ALTER_TREE";
export const TREE_LEDGER_ENV: "ALTER_TREE_LEDGER";
export const TREE_NODE_ENV: "ALTER_NODE";
export const TREE_LEDGER_SCHEMA_VERSION: number;

export type TreeLimits = {
  maxNodes: number | null;
  maxTokens: number | null;
  maxConcurrent: number | null;
};

/** Entries are keyed by a per-run node id, not by the Alter's id, which is allowed to repeat. */
export type TreeLedgerEntry = {
  id: string;
  parent_id: string | null;
  pid: number;
  depth: number;
  started_at: string;
};

export type TreeLedger = {
  schema_version: number;
  tree_id: string;
  started_at: string;
  nodes_admitted: number;
  tokens_spent: number;
  live: TreeLedgerEntry[];
};

/** Opaque handle from `admitTreeNode`; hand it back to `releaseTreeNode`. */
export type TreeNodeHandle = {
  file: string;
  nodeId: string;
  treeId: string;
  limits: TreeLimits;
  lock: FileLockOptions;
  runtime: Runtime;
};

export function treeLedgerPath(root: string, treeId: string): string;
export function treeLimits(cfg: MindConfig): TreeLimits;
/** With every limit off there is nothing to serialize, so the tree pays no ledger at all. */
export function treeGuardsEnabled(limits: TreeLimits): boolean;
/** Reserves one node of the budget and one concurrency slot, blocking at the ceiling and failing once a budget is spent. */
export function admitTreeNode(options: {
  file: string;
  treeId: string;
  parentNodeId?: string | null;
  depth?: number;
  limits: TreeLimits;
  runtime?: Runtime;
  lock?: FileLockOptions;
  admissionTimeoutMs?: number;
  entryStaleMs?: number;
  pollMs?: number;
}): Promise<TreeNodeHandle>;
export function releaseTreeNode(handle: TreeNodeHandle | null, tokensSpent?: number): Promise<TreeLedger | null>;
export function readTreeLedger(file: string): TreeLedger | null;
export function resolveTreeContext(
  root: string,
  options: SpawnOptions,
  runtime: Runtime,
): { treeId: string; file: string; parentNodeId: string | null };
export function withTreeEnv(runtime: Runtime, context: { treeId: string; file: string; nodeId: string }): Runtime;

export type LlmEndpoint = {
  providerId: string;
  modelId: string;
  baseURL: string;
  apiKey: string;
  maxOutputTokens: number | null;
};

export function modelsCatalogPath(env?: Record<string, string | undefined>): string;
export function authFilePath(env?: Record<string, string | undefined>): string;
/** Parsed once per path per process — the catalog is ~3.5MB of JSON. */
export function loadModelsCatalog(file: string): Record<string, unknown>;
export function loadAuth(file: string): Record<string, { type?: string; key?: string; [key: string]: unknown }>;
export function splitModelRef(ref: string): { providerId: string; modelId: string };
/** Pure: the caller supplies the already-loaded catalog and auth. Refuses any non-OpenAI-compatible provider by name. */
export function resolveLlmEndpoint(
  modelRef: string,
  options?: { catalog?: Record<string, unknown>; auth?: Record<string, unknown>; env?: Record<string, string | undefined> },
): LlmEndpoint;
export function resolveLlmEndpointFromDisk(modelRef: string, env?: Record<string, string | undefined>): LlmEndpoint;

export const MIND_HOME_ENV: "MIND_HOME";
export const REGISTRY_SCHEMA_VERSION: number;

/** The registry's inputs: which directories to walk, which roots to include regardless of location. */
export type RegistryConfig = { workspaces: string[]; roots: string[] };

export type RegistryEntry = {
  root: string;
  name: string;
  /** The daemon's liveness signal, preserved across rescans. Reporting only — nothing may depend on it. */
  last_seen: string;
};

/** A pure index, keyed by agent_id and rebuilt by walking the inputs. Deleting it costs only a rescan. */
export type MindRegistry = { schema_version: number; agents: Record<string, RegistryEntry> };

export type RegisteredMind = RegistryEntry & { agentId: string };

export type RegistryScan = {
  index: MindRegistry;
  /** Roots that had no `agent_id` and were given one by the scan. */
  adopted: { root: string; agentId: string; name: string | null }[];
  /** Two roots claiming one identity — almost always a copied mind. The first one wins. */
  conflicts: { agentId: string; kept: string; ignored: string }[];
  /** Explicitly listed roots that are not mind roots. */
  missing: string[];
  workspaces: string[];
  roots: string[];
};

export function mindHomeDir(env?: Record<string, string | undefined>): string;
export function registryPath(env?: Record<string, string | undefined>): string;
export function registryConfigPath(env?: Record<string, string | undefined>): string;
export function defaultWorkspaces(env?: Record<string, string | undefined>): string[];
export function readRegistryConfig(env?: Record<string, string | undefined>): RegistryConfig;
export function writeRegistryConfig(config: Partial<RegistryConfig>, env?: Record<string, string | undefined>): void;
/** Adds a path to the inputs and leaves the rescan to the caller. */
export function addRegistryInput(
  target: "workspace" | "root",
  dir: string,
  env?: Record<string, string | undefined>,
): { added: boolean; path: string; target: "workspaces" | "roots" };
export function removeRegistryInput(
  dir: string,
  env?: Record<string, string | undefined>,
): { removed: boolean; path: string };
export function isMindRoot(dir: string): boolean;
/** Finds mind roots at or under `dir`. Descent stops at the first root on a branch. */
export function discoverMindRoots(dir: string, options?: { maxDepth?: number }): string[];
/** The index as recorded, or null when there is none. Callers that can heal should use `ensureRegistry`. */
export function readRegistry(env?: Record<string, string | undefined>): MindRegistry | null;
/** Walks the inputs and rewrites the index wholesale from what is on disk. */
export function scanRegistry(options?: {
  env?: Record<string, string | undefined>;
  runtime?: Runtime;
  adopt?: boolean;
  maxDepth?: number;
}): Promise<RegistryScan>;
/** A missing index triggers a scan rather than failing. */
export function ensureRegistry(options?: { env?: Record<string, string | undefined>; runtime?: Runtime }): Promise<MindRegistry>;
export function touchMind(
  agentId: string,
  options?: { env?: Record<string, string | undefined>; runtime?: Runtime },
): Promise<RegistryEntry | null>;
/** Resolves an agent_id or a name to a root. An ambiguous name throws rather than guessing. */
export function resolveMind(
  needle: string,
  options?: { env?: Record<string, string | undefined>; runtime?: Runtime; rescanned?: boolean },
): Promise<RegisteredMind>;
export function listMinds(options?: { env?: Record<string, string | undefined>; runtime?: Runtime }): Promise<RegisteredMind[]>;

/**
 * A neuron that has just fired cannot fire again until its refractory period elapses. Two
 * independent guards: `busy` (the previous cycle is still running, answered by a lock) and
 * `refractory` (it finished too recently, answered by the state file). A blocked rhythm is
 * skipped, never queued.
 */
export type RefractoryState = {
  last_started_at?: string;
  last_finished_at?: string;
  last_outcome?: "running" | "ok" | "error";
  last_error?: string | null;
  runs?: number;
};

export type RefractorySkipReason = "busy" | "refractory";

export type RefractorySkip = {
  at: string;
  skipped: RefractorySkipReason;
  pid: number;
  requested_by?: string;
  remainingMs?: number;
};

export function withRefractoryPeriod<T>(
  stateFile: string,
  operation: () => T | Promise<T>,
  options?: { refractoryMs?: number; staleMs?: number; runtime?: Runtime; reason?: string | null },
): Promise<{ ran: true; value: T } | { ran: false; skipped: RefractorySkipReason; remainingMs?: number }>;
export function readRefractoryState(stateFile: string): RefractoryState;
export function readSkipLog(stateFile: string): RefractorySkip[];

export const OSCILLATION_SCHEMA_VERSION: number;

/**
 * A band is a frequency class: documentation plus a default period, nothing more. Naming
 * them exists to make cross-frequency coupling sayable — a slow rhythm gating fast ones.
 */
export const BANDS: Readonly<Record<OscillationBand, string>>;
export type OscillationBand = "fast" | "medium" | "slow" | "circadian";

/** Accepts `"6h"`, `"30m"`, `"500ms"`, `"1d"`, or a plain number of milliseconds. */
export function parseDuration(value: string | number, label?: string): number;
export function formatDuration(ms: number): string;

export function oscillationsDir(root: string): string;
/** State is run-local and untracked; the definitions in `oscillationsDir` are authored config. */
export function oscillationStateDir(root: string): string;
export function oscillationStatePath(root: string, id: string): string;

export type OscillationSpike = {
  id: string;
  /** Same phase means parallel. `after`/`when` may only reference an earlier phase. */
  phase: number;
  graph: string | null;
  catalog: string | null;
  prompt: string | null;
  /** The named spike ran and succeeded. */
  after: string | null;
  /** A dotted path into a named spike's result, tested for truthiness. */
  when: string | null;
  options: Record<string, unknown>;
};

export type Oscillation = {
  schema_version: number;
  id: string;
  band: OscillationBand;
  periodMs: number;
  refractoryMs: number;
  enabled: boolean;
  description: string | null;
  spikes: OscillationSpike[];
};

export type StoredOscillation = Oscillation & { file: string };

export type OscillationSpikeRecord = {
  id: string;
  phase: number;
  state: "ok" | "error" | "skipped";
  duration_ms?: number;
  /** Set when the spike was gated: `after:<id>` or `when:<path>`. */
  skipped?: string;
  result: Record<string, unknown> | null;
  error: string | null;
};

/** One line of the cycle log: an audit record, not a transcript. */
export type OscillationCycle = {
  schema_version: number;
  oscillation: string;
  band: OscillationBand;
  forced: boolean;
  started_at: string;
  finished_at: string;
  spikes: OscillationSpikeRecord[];
};

/** The *schedule* — has a period elapsed. The refractory lock is the separate floor. */
export type OscillationDueness = {
  due: boolean;
  lastRunAt: string | null;
  elapsedMs: number | null;
  dueInMs: number;
};

export function validateOscillation(raw: unknown, options?: { source?: string }): Oscillation;
export function readOscillations(root: string): StoredOscillation[];
export function readOscillation(root: string, id: string): StoredOscillation;
/** Validated before anything touches the disk, so a rejected definition leaves no file behind. */
export function writeOscillation(
  root: string,
  spec: unknown,
  options?: { overwrite?: boolean },
): StoredOscillation & { created: boolean };
/** State is kept by default — it is the rhythm's audit. `purgeState` is for a genuine clean slate. */
export function deleteOscillation(
  root: string,
  id: string,
  options?: { purgeState?: boolean },
): { id: string; file: string; purged: string[] };
export function oscillationDueness(root: string, oscillation: Oscillation, nowMs: number): OscillationDueness;
export function readCycleLog(root: string, id: string): OscillationCycle[];

export type SpikeRunner = (context: {
  spike: OscillationSpike;
  root: string;
  oscillation: Oscillation;
  results: Record<string, unknown>;
  signal?: AbortSignal;
}) => unknown | Promise<unknown>;

export type OscillationLogLine = {
  level: "debug" | "info" | "error";
  [key: string]: unknown;
};

/** Runs one cycle inside the refractory lock. `force` waives the window, never the busy lock. */
export function runOscillation(
  root: string,
  oscillation: Oscillation,
  options: {
    runtime?: Runtime;
    runSpike: SpikeRunner;
    force?: boolean;
    signal?: AbortSignal;
    onLog?: (line: OscillationLogLine) => void;
  },
): Promise<{ ran: true; cycle: OscillationCycle } | { ran: false; skipped: RefractorySkipReason; cycle: null }>;

/**
 * Grants that authorize *unattended* capability use, per mind. Deliberately not the host's
 * interactive policy file: approving a write once with a card in front of you is not the
 * same act as authorizing a rhythm to do it every six hours while you sleep.
 */
export function daemonPolicyPath(root: string): string;
export const BUILTIN_GRAPHS: readonly string[];

/** The production `runSpike`: a builtin graph, or a catalog entry spawned as a one-shot Alter. */
export function createSpikeRunner(
  root: string,
  options?: {
    runtime?: Runtime;
    mindBinPath?: string | null;
    signal?: AbortSignal;
    onEvent?: (event: AlterRuntimeEvent) => void;
  },
): SpikeRunner;

export type DaemonOscillationReport = {
  id: string;
  band: OscillationBand;
  action: "disabled" | "not-due" | "would-run" | "ran" | "skipped";
  dueInMs?: number;
  lastRunAt?: string | null;
  skipped?: RefractorySkipReason | null;
  spikes?: OscillationSpikeRecord[] | null;
};

export type DaemonMindReport = {
  agentId: string;
  name: string;
  root: string;
  oscillations: DaemonOscillationReport[];
  /** One mind's bad oscillation file must not end the tick for every other mind. */
  error: string | null;
};

export type DaemonTick = {
  started_at: string;
  finished_at: string;
  minds: DaemonMindReport[];
  fired: number;
};

export type DaemonTickOptions = {
  env?: Record<string, string | undefined>;
  runtime?: Runtime;
  mindBinPath?: string | null;
  signal?: AbortSignal;
  dryRun?: boolean;
  force?: boolean;
  /** Restrict the tick to one mind, by agent_id or name. */
  only?: string | null;
  onLog?: (line: Record<string, unknown>) => void;
  runSpike?: SpikeRunner | null;
};

/** One pass over every (mind, oscillation) pair. Minds run concurrently, oscillations within a mind sequentially. */
export function runDaemonTick(options?: DaemonTickOptions): Promise<DaemonTick>;
export function runDaemon(
  options?: DaemonTickOptions & {
    intervalMs?: number;
    onTick?: (tick: DaemonTick) => void;
  },
): Promise<{ ticks: number }>;

export const PROFILE_OWNED_FILES: readonly string[];
export function PROFILE_META_PATH(root: string): string;

export type ProfileManifest = { name: string; description: string | null; [key: string]: unknown };

/** Records which profile-owned files were written and their checksums, so `mind update` can tell an untouched copy from an edited one. */
export type ProfileMeta = {
  profile: string;
  source: string | null;
  applied_at: string;
  files: Record<string, string>;
};

/** Throws when no profile ships alongside this build — a broken installation, not a condition to handle. */
export function defaultProfileDir(): string;
export function resolveProfileDir(sourceArg?: string | null): string;
export function loadProfileManifest(profileDir: string): ProfileManifest;
export function readProfileMeta(root: string): ProfileMeta | null;
export function writeProfileMeta(root: string, meta: ProfileMeta): void;
export function sha256(contents: string | Uint8Array): string;
/** Adds the untracked kit paths to the root `.gitignore`. True when it changed the file. */
export function ensureMemoryIgnored(root: string): boolean;

export function isMindProject(dir: string): boolean;

export type InitMindResult = {
  root: string;
  agentId: string;
  name: string;
  profile: string;
  reinitialized: boolean;
  identityPreserved: boolean;
  /** What the previous identity was, when `newIdentity` replaced it — the mind no longer reads the memory it used to. */
  previousAgentId: string | null;
  config: MindConfig;
};

/** `mind init` without the terminal: an explicit target directory, a returned report, no flag parsing. */
export function initMind(
  dir: string,
  options?: {
    name?: string | null;
    source?: string | null;
    profileDir?: string | null;
    force?: boolean;
    /** Re-identify the mind, cutting it off from every memory record the original accumulated. */
    newIdentity?: boolean;
    cliVersion?: string | null;
    runtime?: Runtime;
  },
): InitMindResult;

export const USAGE_SCHEMA_VERSION: number;

export type UsageRange = {
  fromMs: number | null;
  toMs: number | null;
  from: string | null;
  to: string | null;
};

/** Accepts an ISO string, epoch milliseconds, a `Date`, or nothing. Null means unbounded on that side. */
export function resolveRange(options?: { from?: string | number | Date | null; to?: string | number | Date | null }): UsageRange;
/** Parses a run folder's `<timestampSlug>_<id>` prefix. Null when the name does not carry one. */
export function folderTimestampMs(folder: string): number | null;

export type RunSummary = {
  folder: string;
  at: number | null;
  /** False for a run with no `result.json`: in flight, or its process died. It is still counted, and its spend is not guessed. */
  complete: boolean;
  ok: boolean;
  tokens: AlterTokens | null;
  tools: AlterToolUsage | null;
  catalog: string | null;
  model: string | null;
  executor: string | null;
};

export function summarizeRunFolder(home: string, folder: string): RunSummary;

export type UsageBucket = { runs: number; tokens: AlterTokens; tools: AlterToolUsage };

export type SpendUsage = {
  runs: number;
  completed: number;
  failed: number;
  incomplete: number;
  tokens: AlterTokens;
  tools: AlterToolUsage;
  runs_without_tool_data: number;
  /** Runs with neither a parseable `started_at` nor a timestamped folder name. Reported rather than dropped. */
  undatable_runs: number;
  first_run_at: string | null;
  last_run_at: string | null;
  by_catalog: Record<string, UsageBucket>;
  by_model: Record<string, UsageBucket>;
  by_executor: Record<string, UsageBucket>;
};

/** Attempts are the unit that spent tokens, not runs. Only `.alters/runs/` is walked, so graphs are not double-counted. */
export function readSpendUsage(
  root: string,
  options?: { from?: string | number | Date | null; to?: string | number | Date | null },
): SpendUsage;

export type OscillationActivity = {
  id: string;
  band: OscillationBand;
  enabled: boolean;
  cycles: number;
  spikes: number;
  spikes_ok: number;
  spikes_error: number;
  spikes_skipped: number;
  last_cycle_at: string | null;
};

export function readOscillationActivity(
  root: string,
  options?: { from?: string | number | Date | null; to?: string | number | Date | null },
): OscillationActivity[];

export type StorageComponent =
  | "memory"
  | "runs"
  | "graphs"
  | "trees"
  | "state"
  | "oscillations"
  | "catalog"
  | "other";

export type StorageUsage = {
  total_bytes: number;
  /** Broken out of the total: of everything this mind occupies, how much is what it remembers. */
  memory_bytes: number;
  files: number;
  components: Record<StorageComponent, { bytes: number; files: number }>;
  sampled_at: string;
  /** A level, not a flow: this describes the instant it was taken and no interval. */
  sample_duration_ms: number;
};

/** Costs a full directory walk — seconds on a real root. Cache it rather than sampling per render. */
export function readStorageUsage(root: string, options?: { runtime?: Runtime }): Promise<StorageUsage>;

export type Usage = {
  schema_version: number;
  root: string;
  range: { from: string | null; to: string | null };
  spend: SpendUsage;
  oscillations: OscillationActivity[];
  storage: StorageUsage | null;
};

/** `storage: false` skips the expensive half, which is right for a caller refreshing token counts on a timer. */
export function readUsage(
  root: string,
  options?: {
    from?: string | number | Date | null;
    to?: string | number | Date | null;
    storage?: boolean;
    runtime?: Runtime;
  },
): Promise<Usage>;

export class CapabilityDeniedError extends Error {
  capabilityId: string;
}

export class CapabilityUnavailableError extends Error {}
export class CapabilityRequestError extends Error {
  status: number | null;
}

export class MindError extends Error {}
