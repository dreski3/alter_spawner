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

## Hybrid inference and decision routing

The goal is to make a routed inference request the unit of planning while
keeping the current embeddable Node engine as the first integration surface.
An HTTP service, TypeScript migration, and a new concurrency framework are not
prerequisites for the initial routing work.

### 1. Per-Alter ordered model candidates

V1 implements the per-Alter candidate list and ordered fallback contract. See
[Inference routing](docs/inference-routing.md) for the schema and behavior.
Provider and model definitions remain project-level:

```json
{
  "model_candidates": [
    { "id": "local", "model": "mlx/qwen" },
    { "id": "cloud", "model": "openai/gpt-4.1" }
  ]
}
```

Each entry has a stable id and a `provider/model` reference. All candidates use
the Alter's one executor. Existing `model` and `fallback_model` fields continue
to work; an explicit `--model` selects one model. Candidate ids, attempts, and
the candidate model set are recorded, and model authority includes every
candidate. Fallback stops when an OpenCode attempt has begun tool activity.

### 2. Add an in-process request planner

Plan each request against the candidate contract, choosing the model and
backend together. Add the provider/model metadata needed for eligibility,
including input and context limits, cost, and residency. Apply hard data and
capability constraints before ranking candidates. Keep routing separate from
retries: policy selects an eligible candidate before an attempt, while the
attempt policy handles request failures and alternatives. Start with
deterministic rules and the existing `llm` and agent-session adapters. Preserve
the current embedding API.

### 3. Add pluggable decision advisers

Allow optional decision engines to recommend among candidates that already
passed the hard constraints. Evaluate Jev through its API and laya-mlx as a
local decision engine for routing nodes. Validate every recommendation against
the eligible candidate set; keep deterministic behavior when an adviser is
unavailable or returns an unusable choice. Measure decision quality, latency,
and data handling before making either adviser a default.

### 4. Benchmark and refine

Compare direct local requests, direct cloud requests, attached OpenCode
sessions, and spawned sessions on representative tasks. Measure end-to-end
latency, cost, success rate, and quality, including the overhead of routing.
Use results to refine candidate metadata and selection rules.

### 5. Add a service API if host integrations require it

If other applications need to submit and inspect work, expose a narrow API for
request submission, status, cancellation, approvals, and traces. Define job
IDs and idempotent submission for side-effecting work, plus bounded
concurrency. Keep inference routing usable in-process; a network service is a
deployment option, not a prerequisite for the planner.

### 6. Revisit language and packaging

Consider generating the public declarations from TypeScript once the provider,
candidate, and routing contracts have stabilized. Revisit the Node runtime
minimum separately from routing, especially if optional memory backends should
not determine the minimum runtime for every host.
