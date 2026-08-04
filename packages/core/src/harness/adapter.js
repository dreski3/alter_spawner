// A harness adapter runs a prompt for one Alter and reports back what happened.
// `opencode.js` is the only implementation today; a future adapter just needs to
// satisfy this same contract — nothing in scaffold/retry/catalog branches on which
// adapter is in use.
//
// An adapter is chosen per Alter, not per call site: a catalog manifest's
// `executor` names one, and `spawnAlter` resolves it. That is what lets a routing
// Alter and the leaf it spawns run on entirely different machinery while producing
// the same result.json and the same graph trace.
//
// run(home, prompt, opts) -> Promise<{
//   tokens: { input, output, reasoning, cache_read, total },
//   text: string,
//   sessionID: string|null,
//   steps: number,
//   exitCode: number,
//   killed: boolean,
//   ok: boolean,
//   budget_exceeded: boolean,
//   empty_output: boolean,
// }>
// opts: { timeout, depth, alterId, maxTokens, model, pure, recordEvents, attempt, signal,
//         agent, sessionId, title }
//
// `agent` names the harness agent to run as (an Alter home's generated `alter`
// agent by default); `sessionId` continues an existing harness session instead of
// opening a new one, which is what makes a multi-turn principal possible. An
// adapter with no session concept may ignore `sessionId` and report `sessionID: null`.
// `title` names a newly opened session. Supplying one matters beyond cosmetics:
// a harness that titles sessions for you generally does it with a second model
// call, so an adapter should pass a title through rather than let the harness
// infer one. Adapters without a session concept may ignore it.
//
// `ok` is the adapter's own verdict, not just "exited 0": an adapter folds the
// semantic failures it can detect (budget overrun, a clean exit with no final
// message) into it, and reports each as its own boolean so callers can tell the
// reasons apart. retry.js only branches on `ok`/`budget_exceeded`, so a new
// adapter that always reports `empty_output: false` still behaves correctly.

// Besides `run`, an adapter declares what it needs built for it:
//
//   needsAgentHome: boolean (default true)
//
// Every Alter gets a run folder — that is where alter.json and result.json live, and
// `mind list`/`tree`/`show` read them regardless of what actually executed. What
// varies is whether that folder also has to be a *scaffolded agent home*: a git
// boundary, instruction files, a generated agent definition, and for a nestable
// Alter its own `.alters/` kit. A coding harness reads all of that off disk. An
// adapter that makes a single request and returns text reads none of it, and paying
// ~6 file writes plus a `git init` per node to produce files nothing will open is
// the difference between a cheap leaf and a slow one.
//
// Declaring `needsAgentHome: false` also means the adapter has no generated agent
// definition to rewrite, so `spawnAlter` stops retry.js from regenerating one on a
// model swap.
const ADAPTER_DEFAULTS = Object.freeze({ needsAgentHome: true });

export const HARNESS_ADAPTERS = new Map();

export const registerHarness = (name, adapter) => {
  if (typeof adapter?.run !== "function") {
    throw new Error(`harness adapter "${name}" must provide a run function`);
  }
  HARNESS_ADAPTERS.set(name, Object.freeze({ ...ADAPTER_DEFAULTS, ...adapter }));
};

// Executor names are resolved here rather than validated when a manifest is read:
// the set of valid names is exactly the set of registered adapters, and a manifest
// can be written (or copied into a child's kit) long before anything registers one.
export const getHarness = (name) => {
  const adapter = HARNESS_ADAPTERS.get(name);
  if (!adapter) {
    const known = [...HARNESS_ADAPTERS.keys()].sort().join(", ") || "(none registered)";
    throw new Error(`unknown executor: ${name} — registered executors are: ${known}`);
  }
  return adapter;
};
