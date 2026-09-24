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
- Revisit the native Grok executor: a live run saw an expired CLI token and
  repeated permission failures opening `~/.grok/auth.json.lock`, then timed out
  twice before Codex fallback succeeded. Diagnose auth refresh under the
  isolated runtime and confirm a short live smoke run before recommending
  native xAI routing again. Use OpenCode as the default in the meantime.
- Add migration fixtures whenever a persisted schema version changes.

## Hybrid inference and decision routing

The next goal is to let a small, pluggable System 1 decision model choose a
route for a request. Keep the embeddable Node engine as the first integration
surface. An HTTP service, TypeScript migration, and a new concurrency framework
are not prerequisites.

### 1. Per-Alter ordered model candidates — complete

Implemented ordered model candidates, candidate IDs, executor selection, and
bounded fallback. The existing `model` and `fallback_model` fields still work.
See [Inference routing](docs/inference-routing.md) for the current contract.

### 2. Add an in-process request planner — complete

Implemented eligibility checks and deterministic ordering for model/executor
pairs, including provider metadata, authority, capabilities, residency, context,
and estimated cost. The retry layer uses eligible routes and persists its trace.
Mixed direct, OpenCode, and Codex candidates are documented; native Grok remains
deferred under Reliability. See [Inference routing](docs/inference-routing.md).

### 3. Add pluggable System 1 decision advisers — initial scope complete

Support two decision targets through one adviser contract: choosing among model
routes that have already passed the request planner's hard constraints, and
choosing which child Alter a router Alter may spawn. The adviser recommends a
stable candidate ID; the host validates the choice and retains authority over
execution. Start with the already downloaded, locally run `laya-mlx` as the
default adviser for configured router Alters. Load its endpoint and model
settings from project configuration rather than embedding machine-specific
paths. Other local models and remote advisers, including Jev, can use the same
contract later.

The first end-to-end case is a network with a principal and four Alter nodes:
one router and three sibling workers. The network definition declares that the
principal may spawn the router, and that the router may spawn exactly those
three workers. It also defines the router's decision model, the route IDs, and
the descriptions or criteria used to choose among them. Execution is nested:

```text
principal -> router -> one of worker A, worker B, worker C
```

The principal supplies a routing instruction or classification result and a
separate request payload. The router's adviser sees only that routing signal and
its own route definitions. The router checks the returned ID against its allowed
children, spawns the selected worker, and forwards the payload unchanged. The
worker's result returns through the router to the principal. The principal
does not spawn or address the workers directly. This is an optional network
path alongside direct spawning and graphs. A route can also target a
deterministic host capability node to execute a defined operation from the
forwarded input.

Implemented:

- Extend the network definition with explicit spawn edges, router configuration,
  adviser reference, and candidate IDs; validate references, duplicate IDs,
  cycles, and inherited nesting and catalog authority before execution.
- Define a bounded adviser input/output contract and adapter interface. Keep
  the routing signal separate from the opaque request payload so an adviser
  cannot rewrite the worker's task data.
- Add the local `laya-mlx` adapter and make it the default for router nodes
  that omit an adviser reference. Preserve the existing deterministic model
  route ordering when no adviser is configured for ordinary inference.
- Reject out-of-set, malformed, or ambiguous choices. On timeout or adviser
  failure, use a configured deterministic fallback route or fail without
  spawning a worker; never infer a different target from the payload.
- Record the network revision, adviser and model, eligible route IDs, chosen
  route, validation or fallback reason, nested run IDs, latency, and worker
  outcome. Keep request payloads out of decision traces by default.
- Verify classification and routing examples, unchanged payload forwarding,
  forbidden child rejection, failure handling, and the two-level tree budget.

One principal-spawned router now chooses and spawns exactly one authorized
worker with local `laya-mlx`, returns its result, and leaves a trace of the
decision and nested execution. The router can also choose a deterministic
capability node. A live local-model smoke test verifies the two-level path.
The initial network router contract and host API are described in
[Network routing](docs/network-routing.md).
The same opt-in adviser contract now selects among eligible model candidates;
see [Inference routing](docs/inference-routing.md). Benchmarking and broader
adviser adapters remain under the next milestone.

### 4. Benchmark and refine

Compare direct local requests, direct cloud requests, attached OpenCode
sessions, and spawned sessions on representative tasks. Measure end-to-end
latency, cost, success rate, and quality, including the overhead of routing.
For router Alters, compare adviser choices with labeled classification cases
and the deterministic fallback. Measure wrong-route and invalid-choice rates,
decision latency, and whether request data reaches only the chosen worker.
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
