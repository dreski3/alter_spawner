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
  outputContract?: OutputContract | null;
  graphId?: string | null;
  dependsOn?: string[];
  [key: string]: unknown;
};

export type OutputContract =
  | { type: "nonempty"; trim?: boolean }
  | { type: "exact" | "prefix"; value: string; trim?: boolean }
  | { type: "regex"; pattern: string; flags?: string; trim?: boolean }
  | { type: "json"; trim?: boolean };

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
  eventLog?: string | null;
};

export type AlterRuntimeEvent =
  | { type: "attempt.started"; attempt: number; model: string; reason: string }
  | { type: "output.delta"; attempt: number; model: string; delta: string; text: string; sessionID: string | null }
  | { type: "usage.updated"; attempt: number; model: string; tokens: AlterTokens; steps: number; sessionID: string | null };

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
  session_id: string | null;
  event_log: string | null;
  model: string;
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
  attempts: unknown[] | null;
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
    }
  | {
      home: string;
      created: false;
      result: AlterResult;
      res: AlterResponse;
    }
>;

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
    signal?: AbortSignal;
    onEvent?: (event: AlterRuntimeEvent) => void;
    runtime?: Runtime;
  },
): Promise<PrincipalTurn>;

export function registerHarness(
  name: string,
  adapter: {
    run(
      home: string,
      prompt: string,
      options: {
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
      },
    ): Promise<AlterResponse>;
  },
): void;

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

export type GraphMemoryRuntime = {
  scope: MemoryScope;
  recallApprovals?: Pick<CapabilityApprovalSession, "execute">;
  curateApprovals?: Pick<CapabilityApprovalSession, "execute">;
  recall?: typeof runMemoryRecall;
  curate?: typeof runMemoryCurator;
};

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
};

export type MemoryNamespaceStats = {
  records: number;
  activeRecords: number;
  logicalBytes: number;
};

export type MemoryStorageStats = {
  physicalBytes: number;
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
export function createProjectMemoryStore(root: string, options?: {
  file?: string;
  projectId?: string;
  runtime?: Runtime;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  quotaBytes?: number | null;
  namespaceQuotaBytes?: Record<string, number>;
}): MemoryStore;

export const DEFAULT_MEMORY_CATALOG_CAPABILITIES: Readonly<Record<string, readonly string[]>>;
export function createMemoryCapabilityDefinitions(options: { store: MemoryStore }): CapabilityDefinition[];
export function createMemoryCapabilityRegistry(options: {
  store: MemoryStore;
  catalogCapabilities?: Record<string, string[]>;
}): CapabilityRegistry;

export function formatMemoryContext(results: MemorySearchResult[]): string;
export function runMemoryRecall(root: string, options: {
  prompt: string;
  scope: MemoryScope;
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
  plan: { query: string; limit?: number; kinds?: MemoryKind[]; tags?: string[] };
  results: MemorySearchResult[];
  context: string;
  plannerHome: string;
  plannerResult: AlterResult;
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

export class CapabilityDeniedError extends Error {
  capabilityId: string;
}

export class CapabilityUnavailableError extends Error {}
export class CapabilityRequestError extends Error {
  status: number | null;
}

export class MindError extends Error {}
