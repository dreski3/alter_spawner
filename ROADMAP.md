# Roadmap

## Public distribution

- Choose and verify final registry names for the CLI and core package. `mind`
  and `@mind/core` are provisional and must not be published accidentally under
  an unrelated owner's namespace.
- Add the canonical repository, issue tracker, funding, and author metadata once
  their public URLs are selected.
- Publish from a tagged commit through provenance-enabled CI, then validate
  `npx`, global CLI, ESM import, declarations, and initialization from the
  registry artifacts.
- Define the compatibility policy for profile schema, catalog manifests, run
  records, graph results, memory backends, and the public JavaScript API.

## Framework breadth

- Exercise the harness contract with a second session-based coding harness.
- Add semantic retrieval and reranking adapters without changing the memory
  store contract.
- Add first-class metabolic graphs for reward evaluation, abandoned-goal
  discovery, tool-quality review, and safe tool improvement.
- Define how selected metabolic outcomes become future conversational context
  while the rest remain auditable but unconscious to the user-facing agent.

## Reliability

- Continue reducing model-dependent failures in nested `mind spawn` command
  composition.
- Expand live-provider compatibility coverage and publish supported provider
  expectations.
- Add migration fixtures whenever a persisted schema version changes.
