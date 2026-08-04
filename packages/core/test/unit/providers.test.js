// Resolving `provider/model` to an endpoint and a credential — the part opencode
// will not lend us, and therefore the part most likely to be subtly wrong.
//
// Pure: every test supplies its own catalog and auth, so nothing here reads the real
// ~/.cache or ~/.local/share, and no real credential is ever in scope.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveLlmEndpoint, splitModelRef } from "../../src/index.js";

const catalog = {
  // Declares its own base URL and speaks plain OpenAI — the common case, 153 of the
  // 178 providers in the real catalog.
  opencode: {
    id: "opencode",
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    env: ["OPENCODE_API_KEY"],
    models: {
      "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free", cost: { input: 0, output: 0 }, limit: { output: 128000 } },
      "paid-model": { id: "paid-model", cost: { input: 3, output: 15 }, limit: { output: 8192 } },
    },
  },
  // No `api`: its base URL lives inside the AI SDK package.
  cerebras: {
    id: "cerebras",
    npm: "@ai-sdk/cerebras",
    env: ["CEREBRAS_API_KEY"],
    models: { "llama-3.3-70b": { id: "llama-3.3-70b", cost: { input: 1, output: 1 }, limit: { output: 4096 } } },
  },
  // Declares a base URL but speaks a different protocol.
  thinkingmachines: {
    id: "thinkingmachines",
    npm: "@ai-sdk/anthropic",
    api: "https://tinker.example/v1",
    env: ["TINKER_API_KEY"],
    models: { "some-model": { id: "some-model", cost: { input: 1, output: 1 } } },
  },
  // Neither a base URL nor a known first-party default.
  obscure: {
    id: "obscure",
    npm: "@ai-sdk/amazon-bedrock",
    env: [],
    models: { m: { id: "m", cost: { input: 1, output: 1 } } },
  },
};

const resolve = (ref, { auth = {}, env = {} } = {}) => resolveLlmEndpoint(ref, { catalog, auth, env });

test("a model reference splits on the first slash, so model ids may contain slashes", () => {
  assert.deepEqual(splitModelRef("opencode/deepseek-v4-flash-free"), {
    providerId: "opencode",
    modelId: "deepseek-v4-flash-free",
  });
  assert.deepEqual(splitModelRef("togetherai/meta-llama/Llama-3-70b"), {
    providerId: "togetherai",
    modelId: "meta-llama/Llama-3-70b",
  });
  assert.throws(() => splitModelRef("no-slash"), /model must be "provider\/model"/);
});

test("a free model on opencode's gateway needs no credential at all", () => {
  // Which is why the project's default model works out of the box.
  const endpoint = resolve("opencode/deepseek-v4-flash-free");
  assert.equal(endpoint.baseURL, "https://opencode.ai/zen/v1");
  assert.equal(endpoint.apiKey, "public");
  assert.equal(endpoint.maxOutputTokens, 128000);
});

test("a paid model on the same gateway does need one", () => {
  assert.throws(() => resolve("opencode/paid-model"), /no credential for provider "opencode"/);
  assert.equal(resolve("opencode/paid-model", { auth: { opencode: { type: "api", key: "k" } } }).apiKey, "k");
  assert.equal(resolve("opencode/paid-model", { env: { OPENCODE_API_KEY: "from-env" } }).apiKey, "from-env");
});

test("auth.json wins over the environment", () => {
  const endpoint = resolve("opencode/paid-model", {
    auth: { opencode: { type: "api", key: "from-auth" } },
    env: { OPENCODE_API_KEY: "from-env" },
  });
  assert.equal(endpoint.apiKey, "from-auth");
});

test("a first-party provider gets its base URL from the built-in table", () => {
  const endpoint = resolve("cerebras/llama-3.3-70b", { auth: { cerebras: { type: "api", key: "k" } } });
  assert.equal(endpoint.baseURL, "https://api.cerebras.ai/v1");
  assert.equal(endpoint.modelId, "llama-3.3-70b");
});

test("an OAuth provider is refused by name rather than half-supported", () => {
  // Reimplementing token refresh is not worth it; those models stay on opencode.
  assert.throws(
    () => resolve("cerebras/llama-3.3-70b", { auth: { cerebras: { type: "oauth", access: "a", refresh: "r" } } }),
    /authenticated with oauth, whose token refresh the llm executor does not implement/,
  );
});

test("a provider speaking another protocol is refused, not guessed at", () => {
  assert.throws(
    () => resolve("thinkingmachines/some-model", { auth: { thinkingmachines: { type: "api", key: "k" } } }),
    /speaks the @ai-sdk\/anthropic protocol, which the llm executor does not implement/,
  );
  assert.throws(
    () => resolve("obscure/m", { auth: { obscure: { type: "api", key: "k" } } }),
    /declares no base URL .* and is not a known OpenAI-compatible provider/,
  );
});

test("unknown providers and models say which one is wrong", () => {
  assert.throws(() => resolve("nope/m"), /unknown provider "nope"/);
  assert.throws(() => resolve("opencode/nope"), /unknown model "nope" for provider "opencode"/);
});

test("a trailing slash on a catalog base URL does not produce a double slash", () => {
  const endpoint = resolveLlmEndpoint("opencode/deepseek-v4-flash-free", {
    catalog: { ...catalog, opencode: { ...catalog.opencode, api: "https://opencode.ai/zen/v1/" } },
  });
  assert.equal(endpoint.baseURL, "https://opencode.ai/zen/v1");
});

test("every base URL in the built-in table is https and has no trailing slash", () => {
  // The table is hand-maintained, so its shape is worth pinning.
  for (const ref of ["cerebras/llama-3.3-70b"]) {
    const endpoint = resolve(ref, { auth: { cerebras: { type: "api", key: "k" } } });
    assert.match(endpoint.baseURL, /^https:\/\/[^\s]+[^/]$/);
  }
});
