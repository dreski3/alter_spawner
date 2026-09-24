import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSpawnOptions,
  HARNESS_ADAPTERS,
  parseSpawnArgs,
  planRequest,
  registerHarness,
  runExistingAlter,
  spawnAlter,
  validateManifest,
} from "../../src/index.js";

const CANDIDATES = [
  { id: "local", model: "edge/small", executor: "llm" },
  { id: "cloud", model: "remote/large", executor: "opencode" },
];

const NATIVE_CANDIDATES = [
  { id: "grok", model: "xai/grok-4.6", executor: "grok" },
  { id: "codex", model: "openai/gpt-6-luna", executor: "codex" },
];

const PROVIDERS = {
  edge: {
    protocol: "openai-compatible",
    base_url: "http://127.0.0.1:1/v1",
    api_key_env: null,
    models: {
      small: {
        input: ["text"],
        context_tokens: 1024,
        residency: "local",
        cost: { input_per_million: 0.1, output_per_million: 0.2 },
      },
    },
  },
  remote: {
    models: {
      large: {
        input: ["text", "image"],
        context_tokens: 8192,
        residency: "eu",
        cost: { input_per_million: 3, output_per_million: 6 },
      },
    },
  },
};

const makeProject = (t, config = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-planner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "edge/small",
    providers: PROVIDERS,
    retry: { same_harness_retries: 0, fallback_retries: 1 },
    ...config,
  }));
  return root;
};

const reply = (ok, text = "") => ({
  tokens: { input: 2, output: 1, reasoning: 0, cache_read: 0, total: 3 },
  text,
  sessionID: null,
  steps: 1,
  exitCode: ok ? 0 : 503,
  killed: false,
  ok,
  budget_exceeded: false,
  empty_output: false,
  retryable: true,
});

const replaceHarnesses = (t, handlers) => {
  const previous = new Map([...handlers].map(([name]) => [name, HARNESS_ADAPTERS.get(name)]));
  for (const [name, adapter] of handlers) registerHarness(name, adapter);
  t.after(() => {
    for (const [name, adapter] of previous) HARNESS_ADAPTERS.set(name, adapter);
  });
};

test("a pluggable adviser selects only eligible model routes and falls back to deterministic order", async (t) => {
  const root = makeProject(t);
  const seen = [];
  replaceHarnesses(t, [["opencode", {
    needsAgentHome: false,
    async run(_home, prompt, options) {
      seen.push({ prompt, model: options.model });
      return reply(true, options.model);
    },
  }]]);
  const options = () => createSpawnOptions({
    name: "advised",
    prompt: "Classify this request",
    modelCandidates: [
      { id: "local", model: "edge/small", executor: "opencode" },
      { id: "cloud", model: "remote/large", executor: "opencode" },
    ],
    routing: {
      allowed_residencies: ["local", "eu"],
      adviser: {
        id: "test-adviser",
        instructions: "Pick the best route",
        criteria: { local: "fast local", cloud: "larger model" },
      },
    },
  });
  const chosen = await spawnAlter(root, options(), {
    advisers: { "test-adviser": { decide: async ({ routes }) => {
      assert.deepEqual(routes.map((route) => route.id), ["local", "cloud"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { id: "cloud" };
    } } },
  });
  assert.equal(chosen.result.model, "remote/large");
  assert.equal(chosen.result.routing.selected_candidate_id, "cloud");
  assert.equal(chosen.result.routing.adviser.decision_reason, "adviser");
  assert.equal(chosen.result.routing.adviser.outcome, "valid");
  assert.ok(chosen.result.routing.adviser.duration_ms >= 10);
  assert.ok(chosen.result.routing.planner_duration_ms >= 0);
  assert.ok(chosen.result.timing.wall_duration_ms > chosen.result.duration_ms + 10);
  assert.ok(chosen.result.timing.planning_ms >= chosen.result.routing.adviser.duration_ms);
  assert.deepEqual(seen.map((call) => call.model), ["remote/large"]);

  const constrained = options();
  constrained.routing.allowed_residencies = ["eu"];
  const rejected = await spawnAlter(root, constrained, {
    advisers: { "test-adviser": { decide: async () => ({ id: "local" }) } },
  });
  assert.equal(rejected.result.routing.selected_candidate_id, "cloud");
  assert.equal(rejected.result.routing.adviser.decision_reason, "fallback");
  assert.equal(rejected.result.routing.assessed.find((item) => item.candidate_id === "local").eligible, false);
});

test("request planner filters residency and context before ranking by cost", () => {
  const options = createSpawnOptions({
    modelCandidates: CANDIDATES,
    routing: {
      strategy: "lowest_cost",
      allowed_residencies: ["eu"],
      required_context_tokens: 2048,
      estimated_output_tokens: 100,
    },
  });
  const plan = planRequest({ options, config: { providers: PROVIDERS }, prompt: "Review this.", defaultExecutor: "opencode" });
  assert.deepEqual(plan.candidates.map(({ id }) => id), ["cloud"]);
  assert.equal(plan.assessed[0].reason, "residency is not allowed");
  assert.equal(plan.assessed[1].eligible, true);
});

test("lowest cost ranks eligible candidates and a cost limit excludes expensive routes", () => {
  const options = createSpawnOptions({
    modelCandidates: [CANDIDATES[1], CANDIDATES[0]],
    routing: { strategy: "lowest_cost", estimated_output_tokens: 100 },
  });
  const plan = planRequest({ options, config: { providers: PROVIDERS }, prompt: "Review this.", defaultExecutor: "opencode" });
  assert.deepEqual(plan.candidates.map(({ id }) => id), ["local", "cloud"]);
  options.routing.max_estimated_cost_usd = 0.0001;
  const capped = planRequest({ options, config: { providers: PROVIDERS }, prompt: "Review this.", defaultExecutor: "opencode" });
  assert.deepEqual(capped.candidates.map(({ id }) => id), ["local"]);
  assert.equal(capped.assessed[0].reason, "estimated cost exceeds the limit");
});

test("inherited model and executor authority filters routes before selection", () => {
  const options = createSpawnOptions({ modelCandidates: CANDIDATES });
  const authority = {
    schema_version: 1,
    read_grants: [],
    write_grants: [],
    bash_allow: [],
    web: false,
    nestable: false,
    models: ["remote/large"],
    executors: ["opencode"],
    capabilities: [],
    allowed_catalogs: null,
    max_depth: 4,
  };
  const plan = planRequest({
    options,
    config: { providers: PROVIDERS },
    prompt: "Review this.",
    environment: { ALTER_AUTHORITY: JSON.stringify(authority) },
  });
  assert.deepEqual(plan.candidates.map(({ id }) => id), ["cloud"]);
  assert.equal(plan.assessed[0].reason, "model exceeds inherited authority");
});

test("image and tool requirements select only capable routes", () => {
  const imageOptions = createSpawnOptions({ modelCandidates: CANDIDATES, images: ["/example.png"] });
  const images = planRequest({ options: imageOptions, config: { providers: PROVIDERS }, prompt: "Describe the image." });
  assert.deepEqual(images.candidates.map(({ id }) => id), ["cloud"]);
  assert.equal(images.assessed[0].reason, "image input is unsupported");

  const toolsOptions = createSpawnOptions({ modelCandidates: CANDIDATES, routing: { required_capabilities: ["tools"] } });
  const tools = planRequest({ options: toolsOptions, config: { providers: PROVIDERS }, prompt: "Review this." });
  assert.deepEqual(tools.candidates.map(({ id }) => id), ["cloud"]);
  assert.equal(tools.assessed[0].reason, "required capability is unavailable");
});

test("CLI flags define model and executor routes with request policy", () => {
  const options = parseSpawnArgs([
    "--model-candidate", "local=llm:edge/small",
    "--model-candidate", "cloud=opencode:remote/large",
    "--route-strategy", "lowest_cost",
    "--route-residency", "eu",
    "--route-context-tokens", "4096",
    "--route-output-tokens", "100",
    "--route-max-cost", "0.01",
    "--route-require-capability", "tools",
    "Review this.",
  ]);
  assert.deepEqual(options.modelCandidates, CANDIDATES);
  assert.deepEqual(options.routing, {
    strategy: "lowest_cost",
    allowed_residencies: ["eu"],
    required_context_tokens: 4096,
    estimated_output_tokens: 100,
    max_estimated_cost_usd: 0.01,
    required_capabilities: ["tools"],
  });
});

test("routing policy and candidate executors validate in catalog manifests", () => {
  const manifest = {
    name: "router",
    description: "Routes a request.",
    model_candidates: CANDIDATES,
    routing: { strategy: "lowest_cost", required_context_tokens: 2048 },
  };
  assert.doesNotThrow(() => validateManifest(manifest, "router"));
  assert.doesNotThrow(() => validateManifest({
    ...manifest,
    model_candidates: [
      { id: "direct", model: "edge/small", executor: "llm" },
      { id: "session", model: "edge/small", executor: "opencode" },
    ],
  }, "router"));
  assert.throws(() => validateManifest({ ...manifest, routing: { strategy: "random" } }, "router"), /routing.strategy/);
  assert.throws(() => validateManifest({ ...manifest, model_candidates: [{ ...CANDIDATES[0], executor: "function" }] }, "router"), /executor must be llm/);
  assert.doesNotThrow(() => validateManifest({ ...manifest, model_candidates: NATIVE_CANDIDATES }, "router"));
});

test("native Grok can fall back to Codex until a tool has run", async (t) => {
  assert.deepEqual(parseSpawnArgs([
    "--model-candidate", "grok=grok:xai/grok-4.6",
    "--model-candidate", "codex=codex:openai/gpt-6-luna",
    "Review this.",
  ]).modelCandidates, NATIVE_CANDIDATES);
  const root = makeProject(t);
  const calls = [];
  let toolActivity = false;
  replaceHarnesses(t, [
    ["grok", { agentHomeKind: "grok", regeneratesAgentFile: false, run: async (_home, _prompt, options) => {
      calls.push({ executor: "grok", model: options.model });
      return { ...reply(false), tools: { calls: toolActivity ? 1 : 0, errors: 0, byName: toolActivity ? { shell: 1 } : {} } };
    } }],
    ["codex", { agentHomeKind: "codex", regeneratesAgentFile: false, run: async (_home, _prompt, options) => {
      calls.push({ executor: "codex", model: options.model });
      return reply(true, "codex-ok");
    } }],
  ]);
  const { home, result } = await spawnAlter(root, createSpawnOptions({
    prompt: "Review this.",
    description: "Review the request.",
    modelCandidates: NATIVE_CANDIDATES,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.executor, "codex");
  assert.deepEqual(result.attempts.map(({ candidate_id }) => candidate_id), ["grok", "codex"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).model_candidates, NATIVE_CANDIDATES);
  assert.equal(existsSync(path.join(home, ".opencode")), false);
  assert.match(readFileSync(path.join(home, "AGENTS.md"), "utf8"), /Review the request\./);
  assert.deepEqual(calls, [
    { executor: "grok", model: "xai/grok-4.6" },
    { executor: "codex", model: "openai/gpt-6-luna" },
  ]);

  toolActivity = true;
  const rerun = await runExistingAlter(root, home, "Review again.");
  assert.equal(rerun.result.ok, false);
  assert.deepEqual(rerun.result.attempts.map(({ candidate_id }) => candidate_id), ["grok"]);
  assert.equal(calls.length, 3);
});

test("an Alter falls back from direct HTTP to an agent session and preserves route authority on rerun", async (t) => {
  const root = makeProject(t);
  const calls = [];
  replaceHarnesses(t, [
    ["llm", { needsAgentHome: false, supportsRetry: true, run: async (_home, _prompt, options) => {
      calls.push({ executor: "llm", ...options });
      return reply(false);
    } }],
    ["opencode", { supportsImages: true, run: async (_home, _prompt, options) => {
      calls.push({ executor: "opencode", ...options });
      return reply(true, "agent-ok");
    } }],
  ]);
  const options = createSpawnOptions({
    prompt: "Review this.",
    modelCandidates: CANDIDATES,
    routing: { estimated_output_tokens: 100 },
  });
  const { home, result } = await spawnAlter(root, options);
  assert.deepEqual(calls.map(({ executor }) => executor), ["llm", "opencode"]);
  assert.deepEqual(result.attempts.map(({ candidate_id, executor }) => [candidate_id, executor]), [["local", "llm"], ["cloud", "opencode"]]);
  assert.deepEqual(JSON.parse(calls[0].environment.ALTER_AUTHORITY).executors, ["llm", "opencode"]);
  assert.equal(result.executor, "opencode");
  assert.equal(result.model, "remote/large");
  assert.equal(result.routing.selected_candidate_id, "local");
  assert.equal(existsSync(path.join(home, ".opencode", "agents", "alter.md")), true);
  const record = JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
  assert.equal(record.model, "edge/small");
  assert.equal(record.executor, "opencode");
  const rerun = await runExistingAlter(root, home, "Review again.");
  assert.deepEqual(calls.slice(2).map(({ executor }) => executor), ["llm", "opencode"]);
  assert.equal(rerun.result.ok, true);
});

test("a rerun can select an agent route that was ineligible during the original spawn", async (t) => {
  const providers = structuredClone(PROVIDERS);
  providers.remote.models.large.residency = "us";
  const root = makeProject(t, { providers });
  const calls = [];
  replaceHarnesses(t, [
    ["llm", { needsAgentHome: false, supportsRetry: true, run: async (_home, _prompt, options) => {
      calls.push({ executor: "llm", model: options.model });
      return reply(true, "local-ok");
    } }],
    ["opencode", { needsAgentHome: true, regeneratesAgentFile: true, supportsImages: true, run: async (_home, _prompt, options) => {
      calls.push({ executor: "opencode", model: options.model });
      return reply(true, "agent-ok");
    } }],
  ]);
  const options = createSpawnOptions({
    prompt: "Review this.",
    modelCandidates: CANDIDATES,
    routing: { allowed_residencies: ["local", "eu"], estimated_output_tokens: 100 },
  });
  const { home, result } = await spawnAlter(root, options);
  assert.equal(result.executor, "llm");
  assert.equal(existsSync(path.join(home, ".opencode", "agents", "alter.md")), true);

  providers.edge.models.small.residency = "us";
  providers.remote.models.large.residency = "eu";
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "edge/small",
    providers,
    retry: { same_harness_retries: 0, fallback_retries: 1 },
  }));
  const rerun = await runExistingAlter(root, home, "Review again.");
  assert.equal(rerun.result.executor, "opencode");
  assert.equal(rerun.result.routing.selected_candidate_id, "cloud");
  assert.deepEqual(calls, [
    { executor: "llm", model: "edge/small" },
    { executor: "opencode", model: "remote/large" },
  ]);
});

test("a catalog routing policy selects the cheaper model before any attempt", async (t) => {
  const root = makeProject(t);
  const dir = path.join(root, ".alters", "catalog", "reviewer");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    name: "reviewer",
    description: "Reviews a change.",
    model_candidates: [CANDIDATES[1], CANDIDATES[0]],
    routing: { strategy: "lowest_cost", estimated_output_tokens: 100 },
  }));
  const calls = [];
  replaceHarnesses(t, [
    ["llm", { needsAgentHome: false, supportsRetry: true, run: async (_home, _prompt, options) => {
      calls.push(options.model);
      return reply(true, "local-ok");
    } }],
    ["opencode", { run: async (_home, _prompt, options) => {
      calls.push(options.model);
      return reply(true, "cloud-ok");
    } }],
  ]);
  const { result } = await spawnAlter(root, createSpawnOptions({ catalog: "reviewer", prompt: "Review this." }));
  assert.deepEqual(calls, ["edge/small"]);
  assert.equal(result.routing.selected_candidate_id, "local");
  assert.equal(result.executor, "llm");
  assert.equal(result.text, "local-ok");
});

test("a hard residency requirement rejects every candidate before scaffolding", async (t) => {
  const root = makeProject(t);
  await assert.rejects(() => spawnAlter(root, createSpawnOptions({
    prompt: "Review this.",
    modelCandidates: CANDIDATES,
    routing: { allowed_residencies: ["us"] },
  })), /no eligible model candidate/);
  assert.equal(existsSync(path.join(root, ".alters", "runs")), false);
});
