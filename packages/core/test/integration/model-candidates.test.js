import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSpawnOptions,
  HARNESS_ADAPTERS,
  parseSpawnArgs,
  registerHarness,
  readTreeLedger,
  runExistingAlter,
  saveCatalogEntry,
  spawnAlter,
  validateManifest,
} from "../../src/index.js";

const CANDIDATES = [
  { id: "local", model: "local/model-a" },
  { id: "cloud", model: "openai/model-b" },
];

const cli = fileURLToPath(new URL("../../../cli/src/index.js", import.meta.url));

const makeProject = (t, manifest = {}, config = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-candidates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters", "catalog", "reviewer"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "test/default",
    max_depth: 5,
    retry: { same_harness_retries: 1, fallback_retries: 1 },
    ...config,
  }));
  writeFileSync(path.join(root, ".alters", "catalog", "reviewer", "manifest.json"), JSON.stringify({
    name: "reviewer",
    description: "Reviews a change.",
    executor: "opencode",
    model_candidates: CANDIDATES,
    ...manifest,
  }));
  return root;
};

const withOpenCode = (t, run) => {
  const previous = HARNESS_ADAPTERS.get("opencode");
  registerHarness("opencode", { run });
  t.after(() => HARNESS_ADAPTERS.set("opencode", previous));
};

const response = (overrides = {}) => ({
  tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
  text: "done",
  sessionID: null,
  steps: 1,
  exitCode: 1,
  killed: false,
  ok: false,
  budget_exceeded: false,
  empty_output: false,
  retryable: true,
  ...overrides,
});

test("catalog candidate manifests validate and exclude the legacy model fields", () => {
  const manifest = {
    name: "reviewer",
    description: "Reviews a change.",
    model_candidates: CANDIDATES,
  };
  assert.equal(validateManifest(manifest, "reviewer"), undefined);
  assert.throws(
    () => validateManifest({ ...manifest, model: "local/model-a" }, "reviewer"),
    /cannot be combined with model or fallback_model/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, model_candidates: [] }, "reviewer"),
    /must be a non-empty array/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, model_candidates: [CANDIDATES[0], { id: "local", model: "other/model" }] }, "reviewer"),
    /duplicate model candidate id/,
  );
});

test("repeatable model-candidate flags preserve priority order", () => {
  assert.deepEqual(parseSpawnArgs([
    "--model-candidate", "local=local/model-a",
    "--model-candidate", "cloud=openai/model-b",
    "Review this.",
  ]).modelCandidates, CANDIDATES);
  assert.throws(() => parseSpawnArgs(["--model-candidate", "missing-model"]), /expects <id=provider\/model>/);
});

test("invalid candidate catalogs are rejected before writing an entry", (t) => {
  const root = makeProject(t);
  assert.throws(
    () => saveCatalogEntry(root, {}, "invalid", {
      description: "Invalid candidate list.",
      modelCandidates: [CANDIDATES[0], { id: "local", model: "other/model" }],
    }),
    /duplicate model candidate id/,
  );
  assert.equal(existsSync(path.join(root, ".alters", "catalog", "invalid")), false);
  assert.throws(
    () => saveCatalogEntry(root, {}, "empty", { description: "Empty candidate list.", modelCandidates: [] }),
    /model_candidates must be a non-empty array/,
  );
  assert.equal(existsSync(path.join(root, ".alters", "catalog", "empty")), false);
});

test("ordered candidates retry the primary, then advance and persist candidate ids", async (t) => {
  const root = makeProject(t, {}, { max_tree_tokens: 100 });
  const calls = [];
  const events = [];
  withOpenCode(t, async (_home, _prompt, opts) => {
    calls.push(opts);
    return calls.length < 3 ? response() : response({ exitCode: 0, ok: true, retryable: true });
  });

  const { home, result } = await spawnAlter(root, createSpawnOptions({
    catalog: "reviewer",
    prompt: "Review this change.",
  }), { onEvent: (event) => events.push(event) });

  assert.deepEqual(calls.map(({ model }) => model), ["local/model-a", "local/model-a", "openai/model-b"]);
  assert.deepEqual(result.attempts.map(({ candidate_id }) => candidate_id), ["local", "local", "cloud"]);
  assert.deepEqual(result.attempts.map(({ reason }) => reason), ["initial", "retry_same_model", "retry_fallback_model"]);
  assert.deepEqual(events.filter(({ type }) => type === "attempt.started").map(({ candidate_id }) => candidate_id), ["local", "local", "cloud"]);
  assert.equal(result.model, "openai/model-b");
  assert.deepEqual(JSON.parse(calls[0].environment.ALTER_AUTHORITY).models, ["local/model-a", "openai/model-b"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).model_candidates, CANDIDATES);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "result.json"), "utf8")).attempts, result.attempts);
  assert.equal(readTreeLedger(calls[0].environment.ALTER_TREE_LEDGER).tokens_spent, 6);
  const rerun = await runExistingAlter(root, home, "Review once more.");
  assert.equal(calls[3].model, "local/model-a");
  assert.equal(rerun.result.attempts[0].candidate_id, "local");
  assert.equal(readTreeLedger(calls[3].environment.ALTER_TREE_LEDGER).tokens_spent, 2);
});

test("a non-retryable candidate failure advances without repeating that candidate", async (t) => {
  const root = makeProject(t);
  const calls = [];
  withOpenCode(t, async (_home, _prompt, opts) => {
    calls.push(opts);
    return calls.length === 1
      ? response({ retryable: false })
      : response({ exitCode: 0, ok: true, retryable: true });
  });

  const { result } = await spawnAlter(root, createSpawnOptions({ catalog: "reviewer", prompt: "Review." }));
  assert.deepEqual(calls.map(({ model }) => model), ["local/model-a", "openai/model-b"]);
  assert.deepEqual(result.attempts.map(({ candidate_id }) => candidate_id), ["local", "cloud"]);
  assert.deepEqual(result.attempts.map(({ attempt }) => attempt), [1, 2]);
  assert.deepEqual(calls.map(({ attempt }) => attempt), [1, 2]);
  assert.equal(result.ok, true);
});

test("explicit candidate lists override legacy catalog models", async (t) => {
  const root = makeProject(t, { model_candidates: undefined, model: "legacy/primary", fallback_model: "legacy/fallback" });
  const calls = [];
  withOpenCode(t, async (_home, _prompt, opts) => {
    calls.push(opts.model);
    return response({ exitCode: 0, ok: true });
  });

  const { result } = await spawnAlter(root, createSpawnOptions({
    catalog: "reviewer",
    modelCandidates: CANDIDATES,
    prompt: "Review.",
  }));
  assert.deepEqual(calls, ["local/model-a"]);
  assert.equal(result.attempts[0].candidate_id, "local");
});

test("candidate fallback stops after a tool session begins tool activity", async (t) => {
  const root = makeProject(t);
  let calls = 0;
  withOpenCode(t, async () => {
    calls++;
    return response({ toolActivity: true, tools: { calls: 0, errors: 0, byName: {} } });
  });

  const { result } = await spawnAlter(root, createSpawnOptions({ catalog: "reviewer", prompt: "Review." }));
  assert.equal(calls, 1);
  assert.equal(result.attempts[0].tool_activity, true);
  assert.equal(result.ok, false);
});

test("an explicit model pins a catalog run to one model", async (t) => {
  const root = makeProject(t);
  const calls = [];
  withOpenCode(t, async (_home, _prompt, opts) => {
    calls.push(opts.model);
    return response({ exitCode: 0, ok: true });
  });

  const { result } = await spawnAlter(root, createSpawnOptions({
    catalog: "reviewer",
    model: "openai/manual",
    prompt: "Review.",
  }));
  assert.deepEqual(calls, ["openai/manual"]);
  assert.equal(result.attempts[0].candidate_id, undefined);
});

test("the CLI spawns a catalog Alter and falls back across configured providers", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, model: JSON.parse(body).model });
      response.writeHead(request.url.startsWith("/local/") ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url.startsWith("/local/")
        ? { error: { message: "local provider unavailable" } }
        : { choices: [{ message: { content: "cloud-ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
    });
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = makeProject(t, { executor: "llm" }, {
    providers: {
      local: { protocol: "openai-compatible", base_url: `${base}/local/v1`, api_key_env: null, models: { "model-a": {} } },
      openai: { protocol: "openai-compatible", base_url: `${base}/cloud/v1`, api_key_env: null, models: { "model-b": {} } },
    },
    retry: { same_harness_retries: 0, fallback_retries: 1 },
  });
  const command = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "spawn", "--catalog", "reviewer", "Review this."], {
      cwd: root,
      env: process.env,
      timeout: 10000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(command.code, 0, command.stderr);
  assert.equal(command.stdout.trim(), "cloud-ok");
  assert.deepEqual(requests, [
    { url: "/local/v1/chat/completions", model: "model-a" },
    { url: "/cloud/v1/chat/completions", model: "model-b" },
  ]);
  const runs = readdirSync(path.join(root, ".alters", "runs"));
  assert.equal(runs.length, 1);
  const result = JSON.parse(readFileSync(path.join(root, ".alters", "runs", runs[0], "result.json"), "utf8"));
  assert.deepEqual(result.attempts.map(({ candidate_id }) => candidate_id), ["local", "cloud"]);
  assert.deepEqual(result.attempts.map(({ exit_code }) => exit_code), [503, 0]);
  assert.equal(result.model, "openai/model-b");
});
