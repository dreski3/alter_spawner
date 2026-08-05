// Nodes that run without a model at all. The machinery underneath is capabilities.js,
// already tested on its own; what these cover is the adapter contract on top of it —
// zero-token accounting, how a prompt becomes a capability input, the approval split
// between the two executors, and the failure modes that must not look like model
// failures.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityApprovalSession,
  createCapabilityExecutor,
  createCapabilityRegistry,
  createFunctionExecutor,
} from "../../src/index.js";

const textSchema = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 10000 } },
};

const definitions = [
  {
    id: "text.upper",
    name: "Uppercase",
    description: "Uppercases text.",
    approval: "never",
    inputSchema: textSchema,
    handler: ({ input }) => input.text.toUpperCase(),
  },
  {
    id: "text.stats",
    name: "Stats",
    description: "Counts words.",
    approval: "never",
    inputSchema: {
      type: "object",
      required: ["words"],
      additionalProperties: false,
      properties: { words: { type: "array", maxItems: 100, items: { type: "string" } } },
    },
    handler: ({ input }) => ({ count: input.words.length }),
  },
  {
    id: "danger.wipe",
    name: "Wipe",
    description: "Something the user must agree to.",
    approval: "always",
    inputSchema: textSchema,
    handler: ({ input }) => `wiped ${input.text}`,
  },
];

const registry = () => createCapabilityRegistry({ definitions });

const run = (executor, prompt, capability) => executor.run("/unused/home", prompt, { capability });

// --- the function executor -------------------------------------------------------

test("a function node returns transformed text and costs nothing", async () => {
  const executor = createFunctionExecutor({ registry: registry() });
  const res = await run(executor, "hello", { id: "text.upper" });
  assert.equal(res.ok, true);
  assert.equal(res.text, "HELLO");
  assert.equal(res.steps, 1);
  // The whole point of the node type: no model was involved, so nothing was spent.
  assert.deepEqual(res.tokens, { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });
});

test("it declares no agent home and no retries", () => {
  const executor = createFunctionExecutor({ registry: registry() });
  assert.equal(executor.needsAgentHome, false);
  // A deterministic operation gives the same answer twice; retrying is a guaranteed
  // identical failure, and the fallback tier escalates to a model this never used.
  assert.equal(executor.supportsRetry, false);
});

test("the prompt becomes the input, as text or as parsed JSON", async () => {
  const executor = createFunctionExecutor({ registry: registry() });
  assert.equal((await run(executor, "abc", { id: "text.upper", input: "text" })).text, "ABC");

  const structured = await run(executor, JSON.stringify({ words: ["a", "b", "c"] }), {
    id: "text.stats",
    input: "json",
  });
  assert.equal(structured.ok, true);
  // A non-string result is rendered as JSON rather than stringified into [object Object].
  assert.deepEqual(JSON.parse(structured.text), { count: 3 });
});

test("a prompt that should have been JSON fails with a reason, not a crash", async () => {
  const executor = createFunctionExecutor({ registry: registry() });
  const res = await run(executor, "not json at all", { id: "text.stats", input: "json" });
  assert.equal(res.ok, false);
  assert.match(res.capability_error, /expects JSON input/);
  // Not an empty result: retry.js escalates that to a fallback *model*, which is
  // meaningless for a node that never called one.
  assert.equal(res.empty_output, false);
});

test("input that violates the capability's schema fails the run", async () => {
  const executor = createFunctionExecutor({ registry: registry() });
  const res = await run(executor, "", { id: "text.upper" });
  assert.equal(res.ok, false);
  assert.ok(res.capability_error);
});

// --- the safety property ---------------------------------------------------------

test("a function node refuses to run an approval-gated capability", async () => {
  // normalizeDefinition defaults every capability to approval "always", so a host has
  // to have said out loud that an operation needs no gate. Without this check a
  // catalog entry could name a gated capability and quietly skip its gate.
  const executor = createFunctionExecutor({ registry: registry() });
  const res = await run(executor, "everything", { id: "danger.wipe" });
  assert.equal(res.ok, false);
  assert.match(res.capability_error, /requires approval.*use executor "capability" instead/);
});

test("an unbound or missing capability id says what is bound", async () => {
  const executor = createFunctionExecutor({ registry: registry() });
  const unknown = await run(executor, "x", { id: "nope" });
  assert.match(unknown.capability_error, /unknown capability: nope — bound capabilities are: danger\.wipe, text\.stats, text\.upper/);

  const missing = await run(executor, "x", null);
  assert.match(missing.capability_error, /requires the catalog entry to declare a capability id/);
});

test("an executor cannot be built without a registry", () => {
  assert.throws(() => createFunctionExecutor({}), /requires a capability registry/);
  assert.throws(() => createCapabilityExecutor({ registry: registry() }), /requires a createSession factory/);
});

// --- the capability executor -----------------------------------------------------

const sessionFactory = (decision) => {
  const asked = [];
  const createSession = ({ catalogId, signal }) => {
    const session = createCapabilityApprovalSession({
      registry: registry(),
      catalogId,
      signal,
      onEvent: (event) => {
        if (event.type !== "capability.approval_required") return;
        asked.push({ catalogId, capabilityId: event.approval.capabilityId });
        // The host answers out of band, exactly as the bridge does over loopback.
        queueMicrotask(() => session.decide(event.approval.id, decision));
      },
    });
    return session;
  };
  return { createSession, asked };
};

test("a capability node runs only after the host approves", async () => {
  const { createSession, asked } = sessionFactory("allow-once");
  const executor = createCapabilityExecutor({ registry: registry(), createSession });
  const res = await executor.run("/unused/home", "the disk", {
    capability: { id: "danger.wipe" },
    catalogName: "wiper",
  });
  assert.equal(res.ok, true);
  assert.equal(res.text, "wiped the disk");
  assert.deepEqual(res.tokens.total, 0);
  assert.deepEqual(asked, [{ catalogId: "wiper", capabilityId: "danger.wipe" }]);
});

test("a denial is a failed run, not a thrown tree", async () => {
  const { createSession } = sessionFactory("deny");
  const executor = createCapabilityExecutor({ registry: registry(), createSession });
  const res = await executor.run("/unused/home", "the disk", {
    capability: { id: "danger.wipe" },
    catalogName: "wiper",
  });
  assert.equal(res.ok, false);
  assert.match(res.capability_error, /was denied/);
  assert.equal(res.text, "");
});

test("the approval session is keyed by catalog, since grants are persisted per catalog", async () => {
  const { createSession, asked } = sessionFactory("allow-once");
  const executor = createCapabilityExecutor({ registry: registry(), createSession });
  await executor.run("/h", "x", { capability: { id: "danger.wipe" }, alterId: "alter_123" });
  assert.equal(asked[0].catalogId, "alter_123", "falls back to the alter id when there is no catalog");
});

test("naming a host-bound executor that is absent explains itself", async () => {
  const { getHarness } = await import("../../src/harness/adapter.js");
  assert.throws(() => getHarness("function"), /must be bound by the host with a capability registry/);
  // A genuine typo still reads as one.
  assert.throws(() => getHarness("opencide"), /registered executors are: llm, opencode$/);
});
