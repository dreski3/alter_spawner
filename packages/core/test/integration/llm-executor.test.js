// The llm executor against a real HTTP server rather than a stubbed fetch, so what is
// actually on the wire is what gets asserted: one request, no tools, a tiny system
// prompt. The provider catalog and auth file are written into a temp dir and pointed
// at with OPENCODE_MODELS_PATH / XDG_DATA_HOME, so nothing reads the developer's own
// opencode state and no real credential is ever in scope.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpawnOptions, getHarness, spawnAlter } from "@mind/core";

const received = [];
let respond = () => ({ status: 200, body: JSON.stringify({
  choices: [{ message: { role: "assistant", content: "transformed" } }],
  usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
}) });

let server;
let origin;

test.before(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", async () => {
      received.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(raw || "{}"),
        bytes: Buffer.byteLength(raw),
      });
      const { status, body, delayMs } = await respond();
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}/v1`;
});

test.after(() => {
  if (!server) return;
  server.closeIdleConnections();
  server.closeAllConnections();
  server.close();
});

const makeEnvironment = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mind-llm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogFile = path.join(dir, "models.json");
  writeFileSync(
    catalogFile,
    JSON.stringify({
      probe: {
        id: "probe",
        npm: "@ai-sdk/openai-compatible",
        api: origin,
        env: ["PROBE_API_KEY"],
        models: { small: { id: "small", cost: { input: 1, output: 1 }, limit: { output: 4096 } } },
      },
    }),
  );
  mkdirSync(path.join(dir, "data", "opencode"), { recursive: true });
  writeFileSync(
    path.join(dir, "data", "opencode", "auth.json"),
    JSON.stringify({ probe: { type: "api", key: "probe-key" } }),
  );
  return { OPENCODE_MODELS_PATH: catalogFile, XDG_DATA_HOME: path.join(dir, "data") };
};

const makeProject = (t, environment) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-llm-proj-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({
      default_model: "probe/small",
      max_tree_nodes: null,
      max_tree_tokens: null,
      max_concurrent_alters: null,
      retry: { same_harness_retries: 1, fallback_retries: 0 },
    }),
  );
  return { root, environment };
};

const spawn = (root, environment, overrides = {}) =>
  spawnAlter(
    root,
    createSpawnOptions({
      name: "leaf",
      description: "Rewrite the text neutrally.",
      prompt: "the disastrous numbers",
      executor: "llm",
      ...overrides,
    }),
    { runtime: { now: Date.now, randomId: () => "abc123", env: environment, pid: process.pid, isProcessAlive: () => true } },
  );

test("one request, no tools, and a system prompt that is only the role", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  received.length = 0;
  const { home, result } = await spawn(root, environment);

  assert.equal(result.ok, true);
  assert.equal(result.text, "transformed");
  assert.equal(received.length, 1, "exactly one call — no session, no title generation");
  const call = received[0];
  assert.equal(call.url, "/v1/chat/completions");
  assert.equal(call.authorization, "Bearer probe-key");
  assert.equal(call.body.tools, undefined, "a tool-less call carries no tool definitions");
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.messages.map((m) => m.role), ["system", "user"]);
  assert.match(call.body.messages[0].content, /^Rewrite the text neutrally\./);
  assert.match(call.body.messages[0].content, /captured verbatim/);
  assert.equal(call.body.messages[1].content, "the disastrous numbers");
  // For scale: the same leaf on the opencode executor put 1,073 bytes on the wire
  // after Phase 0, and 13,677 before it.
  assert.ok(call.bytes < 600, `expected a small request, got ${call.bytes} bytes`);

  // No agent home, and the trace looks like every other Alter's.
  assert.ok(!existsSync(path.join(home, "AGENTS.md")));
  assert.ok(!existsSync(path.join(home, ".opencode")));
  assert.equal(result.executor, "llm");
  assert.equal(result.steps, 1);
  assert.equal(result.session_id, null);
});

test("validated images are sent as OpenAI-compatible data URL content parts", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  const image = path.join(root, "avatar.png");
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  received.length = 0;
  const { result } = await spawn(root, environment, { images: [image] });

  assert.equal(result.ok, true);
  assert.deepEqual(received[0].body.messages[1].content.map(({ type }) => type), ["text", "image_url"]);
  assert.equal(received[0].body.messages[1].content[0].text, "the disastrous numbers");
  assert.match(received[0].body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("usage is reported from the provider, including reasoning and cache reads", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = () => ({ status: 200, body: JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      completion_tokens_details: { reasoning_tokens: 8 },
      prompt_tokens_details: { cached_tokens: 60 },
    },
  }) });
  const { result } = await spawn(root, environment);
  assert.deepEqual(result.tokens, { input: 100, output: 20, reasoning: 8, cache_read: 60, total: 120 });
});

test("max_tokens caps the request, and the model's own ceiling is the default", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = () => ({ status: 200, body: JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) });

  received.length = 0;
  await spawn(root, environment, { maxTokens: 250 });
  assert.equal(received[0].body.max_tokens, 250, "an explicit cap is sent as the output limit");

  received.length = 0;
  await spawn(root, environment);
  assert.equal(received[0].body.max_tokens, 4096, "otherwise the catalog's own output limit for the model");
});

test("a run over its whole-run budget is reported as over budget, not as success", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = () => ({ status: 200, body: JSON.stringify({
    choices: [{ message: { content: "long answer" } }],
    usage: { prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 },
  }) });
  const { result } = await spawn(root, environment, { maxTokens: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.budget_exceeded, true);
  // Terminal, exactly as for the opencode adapter: the same cap would fail again.
  assert.equal(result.attempts.length, 1);
});

test("an empty completion is the empty-output case and earns the same-model retry", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = () => ({ status: 200, body: JSON.stringify({
    choices: [{ message: { content: "   " } }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  }) });
  received.length = 0;
  const { result } = await spawn(root, environment);
  assert.equal(result.ok, false);
  assert.equal(result.empty_output, true);
  // Unlike a deterministic node, a model returning nothing is often model-specific,
  // so supportsRetry is true and the configured retry is spent.
  assert.equal(result.attempts.length, 2);
  assert.equal(received.length, 2);
});

test("a provider error is a failed run carrying the status, not a thrown tree", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = () => ({ status: 429, body: JSON.stringify({ error: { message: "slow down" } }) });
  const { result } = await spawn(root, environment);
  assert.equal(result.ok, false);
  assert.equal(result.empty_output, false, "a transport failure is not an empty answer");
  assert.equal(result.exit_code, 429);
});

test("a timeout aborts the request rather than waiting out the run", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  respond = async () => ({ status: 200, delayMs: 400, body: JSON.stringify({ choices: [{ message: { content: "late" } }] }) });
  const started = Date.now();
  const { result } = await spawn(root, environment, { timeout: 120 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 2000, "gave up promptly");
  respond = () => ({ status: 200, body: JSON.stringify({
    choices: [{ message: { content: "transformed" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) });
});

test("a misconfigured model fails before any request is made", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  received.length = 0;
  const { result } = await spawn(root, environment, { model: "probe/does-not-exist" });
  assert.equal(result.ok, false);
  assert.equal(received.length, 0, "resolution failures cost nothing");
});

test("the executor declares no agent home and full retry support", () => {
  assert.equal(getHarness("llm").needsAgentHome, false);
  assert.equal(getHarness("llm").supportsRetry, true);
  assert.equal(getHarness("llm").supportsImages, true);
});

test("a sandbox flag on a homeless executor is an error, not a silent no-op", async (t) => {
  const environment = makeEnvironment(t);
  const { root } = makeProject(t, environment);
  received.length = 0;
  // `executor: "llm", web: true` reads like a web-capable node. It cannot be one, so
  // it must not resolve into a plain completion that quietly ignores the claim.
  await assert.rejects(
    () => spawn(root, environment, { webAccess: true }),
    /executor "llm" runs without a sandbox, so it cannot be combined with web/,
  );
  await assert.rejects(
    () => spawn(root, environment, { nestable: true, readGrants: ["/tmp"] }),
    /cannot be combined with nestable, read_grants/,
  );
  assert.equal(received.length, 0);
});
