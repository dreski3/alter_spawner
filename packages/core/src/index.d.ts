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
export function writeTextAtomic(file: string, content: string): void;
export function writeJsonAtomic(file: string, value: unknown): void;
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
  webAccess?: boolean;
  promptPrefix?: string;
  promptSuffix?: string;
  opencodeProvider?: Record<string, unknown>;
  outputContract?: OutputContract;
};

export function validateOutputContract(contract: OutputContract | null, label?: string): void;
export function checkOutputContract(
  text: string,
  contract: OutputContract | null,
): { ok: boolean; error: string | null };

export type AlterGraph = {
  id?: string;
  output?: string;
  nodes: AlterGraphNode[];
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
  },
): Promise<{ home: string; result: Record<string, unknown> }>;

export class MindError extends Error {}
