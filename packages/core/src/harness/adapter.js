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
// }>
// opts: { timeout, depth, alterId, maxTokens }

export const HARNESS_ADAPTERS = new Map();

export const registerHarness = (name, adapter) => {
  HARNESS_ADAPTERS.set(name, adapter);
};

export const getHarness = (name) => {
  const adapter = HARNESS_ADAPTERS.get(name);
  if (!adapter) throw new Error(`unknown harness: ${name}`);
  return adapter;
};
