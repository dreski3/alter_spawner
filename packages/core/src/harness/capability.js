// Two executors that run a node without a model.
//
//   function   — a trusted local operation, executed directly. Zero tokens, zero
//                model latency, no approval prompt.
//   capability — the same machinery routed through the host's approval gate, so a
//                node can do something the user has to agree to first.
//
// Both are thin: `capabilities.js` already had the hard parts. A `handler` definition
// is a JS function with a JSON-Schema-validated input and a normalized, size-capped
// result — that is a function node. `createCapabilityApprovalSession` already carries
// run-scoped and persistent grants over loopback HTTP — that is a capability node.
// What was missing was only the seam that lets an Alter be one, which Phase 1 added.
//
// NOT SELF-REGISTERING, unlike the opencode adapter, and deliberately so. A registry
// is host-built JS: the host decides which operations exist and binds them. There is
// no path that loads capability definitions from a project directory, because a
// nestable Alter has write access to its own home, its home is the project root for
// anything it spawns, and it is allowed to run `node <mind> ...`. Loading project-local
// JS would therefore let it write a definition file and execute arbitrary code —
// turning a scoped-bash sandbox into none at all. The consequence is a real
// limitation, stated plainly: function and capability nodes are available to
// in-process callers (a host, or `runAlterGraph` driven by one) and not to
// `mind spawn` running inside a nestable Alter.

import { CapabilityDeniedError } from "../capabilities.js";

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 });

const failed = (message) => {
  process.stderr.write(`(alter capability) ${message}\n`);
  return {
    tokens: { ...ZERO_TOKENS },
    text: "",
    sessionID: null,
    steps: 0,
    exitCode: 1,
    killed: false,
    ok: false,
    budget_exceeded: false,
    // A capability that failed did not "return nothing" — it did not run. Reporting
    // empty_output would send retry.js escalating to a fallback *model*, which is
    // meaningless for something that never involved one.
    empty_output: false,
    capability_error: message,
  };
};

// A command capability takes no structured input; a handler capability declares a
// schema and the prompt has to be shaped to fit it. Two modes, both explicit:
// `text` (the default) hands the prompt over as `{ text }`, which is the shape a
// text-in/text-out transformer wants; `json` parses the prompt first, for nodes whose
// upstream produces a structured payload.
const buildInput = (definition, prompt, mode) => {
  if (!definition.inputSchema) return undefined;
  if (mode === "json") {
    try {
      return JSON.parse(prompt);
    } catch (error) {
      throw new Error(`capability ${definition.id} expects JSON input but the prompt did not parse: ${error.message}`);
    }
  }
  return { text: prompt };
};

// A handler reports its result in `value`, a command in `stdout`. A node meant to
// hand text to a downstream Alter should return a string; anything else is rendered
// as JSON rather than stringified into "[object Object]".
const resultText = (outcome) => {
  if (outcome.value === null || outcome.value === undefined) return outcome.stdout || "";
  return typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value, null, 2);
};

const runCapability = async ({ registry, execute, capability, prompt, definitionGuard }) => {
  if (!capability || typeof capability.id !== "string" || !capability.id) {
    return failed("this executor requires the catalog entry to declare a capability id.");
  }
  const definition = registry.get(capability.id);
  if (!definition) {
    const known = registry.listPublic().map((entry) => entry.id).sort().join(", ") || "(none bound)";
    return failed(`unknown capability: ${capability.id} — bound capabilities are: ${known}`);
  }
  const guardError = definitionGuard?.(definition);
  if (guardError) return failed(guardError);
  let input;
  try {
    input = buildInput(definition, prompt, capability.input || "text");
  } catch (error) {
    return failed(error.message);
  }
  try {
    const outcome = await execute(capability.id, input === undefined ? {} : { input });
    const text = resultText(outcome);
    return {
      tokens: { ...ZERO_TOKENS },
      text,
      sessionID: null,
      steps: 1,
      exitCode: outcome.exitCode ?? (outcome.ok ? 0 : 1),
      killed: false,
      ok: !!outcome.ok,
      budget_exceeded: false,
      empty_output: false,
      capability_error: outcome.ok ? null : outcome.stderr || null,
    };
  } catch (error) {
    // A denial is a legitimate outcome rather than a crash, so it lands as a failed
    // run with a reason instead of tearing down the tree around it.
    const reason = error instanceof CapabilityDeniedError ? error.message : (error?.message || String(error));
    return failed(reason);
  }
};

// Runs a trusted operation with no approval prompt. The `approval: "never"` guard is
// the safety property: `normalizeDefinition` defaults every capability to "always", so
// a host has to have said out loud that this one needs no gate. Without the check, a
// catalog entry could name an approval-gated capability and quietly skip its gate.
export const createFunctionExecutor = ({ registry }) => {
  if (!registry?.get || !registry?.execute) throw new Error("function executor requires a capability registry");
  return Object.freeze({
    needsAgentHome: false,
    // A deterministic operation returns the same answer to the same input, so a retry
    // is a guaranteed-identical second failure, and a fallback *model* is incoherent
    // for a node that never called one.
    supportsRetry: false,
    run: (home, prompt, { capability } = {}) =>
      runCapability({
        registry,
        capability,
        prompt,
        execute: (id, options) => registry.execute(id, options),
        definitionGuard: (definition) =>
          definition.approval === "never"
            ? null
            : `capability ${definition.id} requires approval, so it cannot run as a function node — use executor "capability" instead.`,
      }),
  });
};

// Same execution path, but every run passes through the host's approval gate. The
// session is host-built because the decisions, the persistence and the audit trail
// are the host's: core cannot invent who is being asked or where the answer is kept.
export const createCapabilityExecutor = ({ registry, createSession }) => {
  if (!registry?.get) throw new Error("capability executor requires a capability registry");
  if (typeof createSession !== "function") throw new Error("capability executor requires a createSession factory");
  return Object.freeze({
    needsAgentHome: false,
    supportsRetry: false,
    run: (home, prompt, { capability, catalogName, alterId, signal, onEvent } = {}) => {
      let session;
      try {
        session = createSession({ catalogId: catalogName || alterId || "alter", signal, onEvent });
      } catch (error) {
        // A host that cannot produce a session for this run — no approval context,
        // for instance — is a node that cannot run, not a tree that should unwind.
        return Promise.resolve(failed(error?.message || String(error)));
      }
      return runCapability({
        registry,
        capability,
        prompt,
        execute: (id, options) => session.execute(id, { ...options, signal }),
      });
    },
  });
};
