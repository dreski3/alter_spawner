// A harness adapter runs a prompt against an already-scaffolded Alter home and
// reports back what happened. `opencode.js` is the only implementation today;
// a future adapter (e.g. for a different coding harness) just needs to satisfy
// this same contract — nothing in scaffold/retry/catalog branches on harness.
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

export const HARNESS_ADAPTERS = new Map();

export const registerHarness = (name, adapter) => {
  HARNESS_ADAPTERS.set(name, adapter);
};

export const getHarness = (name) => {
  const adapter = HARNESS_ADAPTERS.get(name);
  if (!adapter) throw new Error(`unknown harness: ${name}`);
  return adapter;
};
