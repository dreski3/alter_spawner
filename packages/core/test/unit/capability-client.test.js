import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_TOKEN_ENV,
  CAPABILITY_URL_ENV,
  CapabilityRequestError,
  CapabilityUnavailableError,
  formatPutOutcome,
  formatSearchOutcome,
  putMemory,
  requestCapability,
  resolveCapabilityEndpoint,
  searchMemory,
  withoutCapabilityGrant,
} from "../../src/index.js";

const grantEnv = (overrides = {}) => ({
  [CAPABILITY_URL_ENV]: "http://127.0.0.1:8788/capability",
  [CAPABILITY_TOKEN_ENV]: "tok_abc",
  ...overrides,
});

const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const recorder = (status, body) => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return respond(status, body);
    },
  };
};

test("with no endpoint in the environment there is no fallback path", async () => {
  await assert.rejects(
    () => requestCapability("memory.records.search", { env: {}, input: { query: "x" } }),
    (error) => error instanceof CapabilityUnavailableError && /must both be set/.test(error.message),
  );
  await assert.rejects(
    () => requestCapability("memory.records.search", { env: grantEnv({ [CAPABILITY_TOKEN_ENV]: "" }), input: {} }),
    CapabilityUnavailableError,
  );
});

test("an endpoint off this machine is refused before anything is sent", () => {
  for (const url of ["http://memory.example.com/capability", "http://10.0.0.4:8788/capability"]) {
    assert.throws(
      () => resolveCapabilityEndpoint(grantEnv({ [CAPABILITY_URL_ENV]: url })),
      /must address the loopback interface/,
      `${url} must not be accepted`,
    );
  }
  assert.throws(
    () => resolveCapabilityEndpoint(grantEnv({ [CAPABILITY_URL_ENV]: "file:///etc/passwd" })),
    /must be an http or https URL/,
  );
  assert.throws(
    () => resolveCapabilityEndpoint(grantEnv({ [CAPABILITY_URL_ENV]: "not a url" })),
    /not a valid URL/,
  );
  assert.equal(
    resolveCapabilityEndpoint(grantEnv({ [CAPABILITY_URL_ENV]: "http://[::1]:8788/capability" })).token,
    "tok_abc",
  );
});

test("a request carries the turn's token and the host's answer comes back", async () => {
  const { calls, fetchImpl } = recorder(200, { ok: true, decision: "allow", value: { results: [] } });
  const outcome = await requestCapability("memory.records.search", {
    env: grantEnv(),
    fetchImpl,
    input: { query: "ports" },
    reason: "because",
  });

  assert.equal(calls[0].url, "http://127.0.0.1:8788/capability");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok_abc");
  assert.deepEqual(calls[0].body, { capabilityId: "memory.records.search", input: { query: "ports" }, reason: "because" });
  assert.deepEqual(outcome, { decision: "allow", value: { results: [] }, error: null });
});

test("a denial comes back as an answer, not a thrown failure", async () => {
  const { fetchImpl } = recorder(200, { ok: false, decision: "deny", error: "Write persistent memory was denied." });
  const outcome = await requestCapability("memory.records.write", { env: grantEnv(), fetchImpl, input: { records: [] } });
  assert.equal(outcome.decision, "deny");
  assert.equal(outcome.value, null);
});

test("a rejected token is unavailability; a refused request is a request error", async () => {
  await assert.rejects(
    () => requestCapability("memory.records.search", {
      env: grantEnv(),
      fetchImpl: recorder(401, { error: "no active turn holds this capability token" }).fetchImpl,
      input: {},
    }),
    CapabilityUnavailableError,
  );
  await assert.rejects(
    () => requestCapability("memory.records.search", {
      env: grantEnv(),
      fetchImpl: recorder(403, { error: "this turn was not granted memory.records.search" }).fetchImpl,
      input: {},
    }),
    (error) => error instanceof CapabilityRequestError && error.status === 403,
  );
});

test("an unreachable host is unavailability, not a crash", async () => {
  await assert.rejects(
    () => requestCapability("memory.records.search", {
      env: grantEnv(),
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
      input: {},
    }),
    (error) => error instanceof CapabilityUnavailableError && /could not be reached/.test(error.message),
  );
});

test("a grant is stripped from an environment handed further down", () => {
  const stripped = withoutCapabilityGrant(grantEnv({ PATH: "/usr/bin", ALTER_DEPTH: "0" }));
  assert.equal(CAPABILITY_URL_ENV in stripped, false);
  assert.equal(CAPABILITY_TOKEN_ENV in stripped, false);
  assert.deepEqual(stripped, { PATH: "/usr/bin", ALTER_DEPTH: "0" });
});

test("a memory search never sends a scope and never sends tags", async () => {
  const { calls, fetchImpl } = recorder(200, { ok: true, value: { results: [] } });
  await searchMemory({ query: "  bridge port  ", limit: 3, kinds: ["fact"], env: grantEnv(), fetchImpl });
  assert.deepEqual(calls[0].body.input, { query: "bridge port", limit: 3, kinds: ["fact"] });
});

test("a memory write sends one record and no provenance of its own", async () => {
  const { calls, fetchImpl } = recorder(200, { ok: true, value: { records: [] } });
  await putMemory({
    content: "The relay dev server runs on port 3003.",
    kind: "fact",
    tags: ["relay"],
    confidence: 0.9,
    env: grantEnv(),
    fetchImpl,
  });
  assert.deepEqual(calls[0].body.input, {
    records: [{ kind: "fact", content: "The relay dev server runs on port 3003.", tags: ["relay"], confidence: 0.9 }],
  });
  assert.equal("scope" in calls[0].body.input, false);
  assert.equal("source" in calls[0].body.input.records[0], false);
});

test("bad memory arguments fail before the host is asked", async () => {
  const { calls, fetchImpl } = recorder(200, { ok: true, value: {} });
  await assert.rejects(() => searchMemory({ query: "  ", env: grantEnv(), fetchImpl }), /non-empty string/);
  await assert.rejects(() => searchMemory({ query: "x", limit: 0, env: grantEnv(), fetchImpl }), /from 1 to 100/);
  await assert.rejects(() => searchMemory({ query: "x", kinds: ["gossip"], env: grantEnv(), fetchImpl }), /memory kind must be/);
  await assert.rejects(() => putMemory({ content: "x", kind: "gossip", env: grantEnv(), fetchImpl }), /memory kind must be/);
  await assert.rejects(() => putMemory({ content: "x", confidence: 2, env: grantEnv(), fetchImpl }), /between 0 and 1/);
  assert.equal(calls.length, 0);
});

test("a denial reads as settled, and tells the model not to ask again", () => {
  const search = formatSearchOutcome({ decision: "deny", results: [] });
  assert.match(search, /^denied:/);
  assert.match(search, /continue without/);
  assert.match(formatPutOutcome({ decision: "deny", records: [] }), /do not try again/);
});

test("search output names each record so a follow-up can cite it", () => {
  const output = formatSearchOutcome({
    decision: "allow",
    results: [{
      record: { id: "mem_1", kind: "preference", content: "No comments unless asked.", tags: ["style"] },
      score: 12,
      matchedTerms: ["comments"],
    }],
  });
  assert.match(output, /1 record matched/);
  assert.match(output, /\[preference\] mem_1 \(score 12, tags: style, matched: comments\)/);
  assert.match(output, /No comments unless asked\./);
  assert.match(formatSearchOutcome({ decision: "allow", results: [] }), /no records matched/);
});
