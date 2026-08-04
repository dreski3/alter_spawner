import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityDeniedError,
  createCapabilityApprovalSession,
  createCapabilityRegistry,
  grantCatalogCapability,
  hasCatalogGrant,
  VALID_APPROVAL_DECISIONS,
} from "@mind/core";

const createRegistry = () => createCapabilityRegistry({
  definitions: [{
    id: "test.echo",
    name: "Echo trusted text",
    description: "Runs a fixed test executable.",
    approval: "always",
    risk: "low",
    timeoutMs: 1000,
    maxOutputBytes: 100,
    executors: { test: { file: "/usr/bin/printf", args: ["trusted-output"] } },
  }],
  catalogCapabilities: { tester: ["test.echo"] },
});

const createStructuredRegistry = (handler, overrides = {}) => createCapabilityRegistry({
  definitions: [{
    id: "memory.records.write",
    name: "Store memory records",
    description: "Stores validated memory records.",
    approval: "always",
    allowedDecisions: ["allow-once", "deny"],
    executorVersion: "memory-write-v1",
    inputSchema: {
      type: "object",
      required: ["records"],
      additionalProperties: false,
      properties: {
        records: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            required: ["content"],
            additionalProperties: false,
            properties: { content: { type: "string", minLength: 1, maxLength: 200 } },
          },
        },
      },
    },
    approvalPreview: (input) => ({ records: input.records }),
    handler,
    ...overrides,
  }],
});

test("registry binds catalogs without exposing registered executors", async () => {
  const registry = createRegistry();
  assert.equal(registry.forCatalog("tester")[0].id, "test.echo");
  assert.deepEqual(registry.forCatalog("other"), []);
  assert.equal(registry.commandPreview("test.echo", "test"), "/usr/bin/printf trusted-output");
  assert.equal("executors" in registry.listPublic()[0], false);
  assert.throws(() => { registry.get("test.echo").executors.test.file = "/bin/echo"; }, TypeError);
  assert.equal(registry.commandPreview("test.echo", "test"), "/usr/bin/printf trusted-output");
  await assert.rejects(registry.execute("missing"), /unknown capability/);
});

test("approval session pauses before executing the registered capability", async () => {
  const events = [];
  const session = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    createId: () => "approval_test",
    onEvent: (event) => events.push(event),
  });
  const execution = session.execute("test.echo", { platform: "test", reason: "Required for the test." });
  assert.equal(session.getPendingApproval().id, "approval_test");
  assert.equal(session.getPendingApproval().commandPreview, "/usr/bin/printf trusted-output");
  assert.deepEqual(events.map((event) => event.type), ["capability.approval_required"]);
  await session.decide("approval_test", "allow-once");
  const result = await execution;
  assert.equal(result.stdout, "trusted-output");
  assert.deepEqual(events.map((event) => event.type), [
    "capability.approval_required",
    "capability.approved",
    "capability.execution_started",
    "capability.execution_completed",
  ]);
});

test("denial cannot execute or alter the registered command", async () => {
  const events = [];
  const session = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    createId: () => "approval_denied",
    onEvent: (event) => events.push(event),
  });
  const execution = session.execute("test.echo", { platform: "test" });
  await session.decide("approval_denied", "deny");
  await assert.rejects(execution, CapabilityDeniedError);
  assert.deepEqual(events.map((event) => event.type), ["capability.approval_required", "capability.denied"]);
});

test("run and catalog grants retain their documented scopes", async () => {
  let policy = { catalogGrants: {} };
  let nextId = 0;
  const events = [];
  const session = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    createId: () => `approval_${nextId += 1}`,
    isPersistentlyApproved: ({ catalogId, capabilityId }) => hasCatalogGrant(policy, catalogId, capabilityId),
    persistApproval: ({ catalogId, capabilityId }) => {
      policy = grantCatalogCapability(policy, catalogId, capabilityId);
    },
    onEvent: (event) => events.push(event),
  });
  const first = session.authorize("test.echo");
  await session.decide("approval_1", "allow-run");
  await first;
  assert.equal((await session.authorize("test.echo")).decision, "allow-run");
  assert.equal(events.at(-1).type, "capability.auto_approved");

  const persistentSession = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    createId: () => "approval_persistent",
    isPersistentlyApproved: ({ catalogId, capabilityId }) => hasCatalogGrant(policy, catalogId, capabilityId),
    persistApproval: ({ catalogId, capabilityId }) => {
      policy = grantCatalogCapability(policy, catalogId, capabilityId);
    },
  });
  const persistent = persistentSession.authorize("test.echo");
  await persistentSession.decide("approval_persistent", "always-catalog");
  await persistent;
  const nextSession = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    isPersistentlyApproved: ({ catalogId, capabilityId }) => hasCatalogGrant(policy, catalogId, capabilityId),
  });
  assert.equal((await nextSession.authorize("test.echo")).decision, "always-catalog");
  assert.equal(hasCatalogGrant(policy, "other", "test.echo"), false);
});

test("approval decisions are explicit and pending approval cancels with the run", async () => {
  assert.deepEqual([...VALID_APPROVAL_DECISIONS], ["allow-once", "allow-run", "always-catalog", "deny"]);
  assert.equal(VALID_APPROVAL_DECISIONS.add, undefined);
  const guarded = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    createId: () => "approval_guarded",
  });
  const guardedAuthorization = guarded.authorize("test.echo");
  await assert.rejects(guarded.decide("approval_guarded", "allow-shell"), /invalid approval decision/);
  await guarded.decide("approval_guarded", "deny");
  await guardedAuthorization;
  const controller = new AbortController();
  const session = createCapabilityApprovalSession({
    registry: createRegistry(),
    catalogId: "tester",
    signal: controller.signal,
  });
  const authorization = session.authorize("test.echo");
  controller.abort();
  await assert.rejects(authorization, /cancelled while waiting/);
  assert.equal(session.getPendingApproval(), null);
});

test("structured inputs are validated, cloned, frozen, and bound to approval", async () => {
  const received = [];
  const registry = createStructuredRegistry(({ input }) => {
    received.push(input);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.records), true);
    return { stored: input.records.length };
  });
  const session = createCapabilityApprovalSession({
    registry,
    catalogId: "memory-curator",
    createId: () => "approval_memory",
  });
  const input = { records: [{ content: "Use port 8788." }] };
  const execution = session.execute("memory.records.write", { input });
  input.records[0].content = "Mutated after approval request.";
  const approval = session.getPendingApproval();
  assert.match(approval.executionDigest, /^[a-f0-9]{64}$/);
  assert.equal(approval.executorVersion, "memory-write-v1");
  assert.deepEqual(approval.inputPreview, { records: [{ content: "Use port 8788." }] });
  assert.deepEqual(approval.allowedDecisions, ["allow-once", "deny"]);
  await assert.rejects(session.decide("approval_memory", "allow-run"), /not allowed/);
  await session.decide("approval_memory", "allow-once");
  const result = await execution;
  assert.deepEqual(received, [{ records: [{ content: "Use port 8788." }] }]);
  assert.deepEqual(result.value, { stored: 1 });
});

test("structured invocation digests are canonical and executor-versioned", () => {
  const handler = () => ({ ok: true });
  const registry = createStructuredRegistry(handler);
  const first = registry.prepare("memory.records.write", {
    input: { records: [{ content: "Remember this." }] },
  });
  const same = registry.prepare("memory.records.write", {
    input: { records: [{ content: "Remember this." }] },
  });
  const changed = registry.prepare("memory.records.write", {
    input: { records: [{ content: "Remember something else." }] },
  });
  const upgraded = createStructuredRegistry(handler, { executorVersion: "memory-write-v2" })
    .prepare("memory.records.write", { input: { records: [{ content: "Remember this." }] } });
  assert.equal(first.executionDigest, same.executionDigest);
  assert.notEqual(first.executionDigest, changed.executionDigest);
  assert.notEqual(first.executionDigest, upgraded.executionDigest);
});

test("structured capabilities reject invalid input and forged invocations", async () => {
  let calls = 0;
  const registry = createStructuredRegistry(() => {
    calls += 1;
    return { ok: true };
  });
  await assert.rejects(
    registry.execute("memory.records.write", { input: { records: [], unexpected: true } }),
    /unexpected is not allowed|at least 1 items/,
  );
  await assert.rejects(
    registry.executePrepared({ capabilityId: "memory.records.write" }),
    /was not prepared by this registry/,
  );
  assert.equal(calls, 0);
});
