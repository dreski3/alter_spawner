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

Build a repeatable benchmark before changing candidate priorities or adviser
rules. Keep task inputs, labels, configuration, model versions, pricing sources,
raw run references, and analysis together so a result can be reproduced.

#### 4.1 Finish measurement and attribution — complete

- The run result now records planning, adviser, admission, scaffold, execution,
  and monotonic attempt times. Network decisions record their outcome and
  latency, including invalid and failed choices. `summarizeRunTree` counts
  retries and descendants, follows the selected router child, and separates
  priced usage from unknown cost. A four-level Alter test covers the reader.
- Public spawn and rerun timing now includes initial result persistence and
  tree-slot release; network and principal timing covers their public calls.
  Failed calls emit a sanitized measurement and save it under
  `.alters/measurements/` when a project home exists, including failures before
  a run home is created. Tree summaries expose root wall time and summed node
  time separately so parallel branches are not treated as serial latency.
- Each attempt saves a snapshot of its provider/model metadata and configured
  prices. Tree summaries use that snapshot for new runs and count missing token
  reports, missing prices, unreported adviser decisions, and incomplete runs.
  Unknown total cost remains null. Decision traces and benchmark summaries do
  not include prompts or payloads by default.

#### 4.2 Build a labeled task set — complete

- Include short classification, extraction with an output contract, reasoning,
  image input, and tool-using tasks. Score exact checks where possible and use
  a blinded rubric for answers that need judgment. Record both harness success
  and task quality; a completed request can still be wrong.
- Label router signals for the three worker routes and the capability route.
  Add ambiguous cases, out-of-set choices, adviser errors and timeouts, and
  payload canaries. Assert that the adviser sees only the routing signal and
  that only the chosen worker receives the payload.
- Add nested Alter workloads with depth 1, 2, 4, and 8, including a chain and
  a branching tree. Record node count, queue time, retries, token spend, and
  failures at each depth. Router-to-router edges are currently rejected; add
  labeled multi-router cases after that execution path is implemented.

The versioned set in `benchmarks/task-set-v1.json` now contains ten task cases,
thirteen router cases, and eight nested workloads. Automatic scorers and blind
review packets keep harness success separate from task quality. Scripted router
fixtures assert payload isolation and fallback behavior. The nested runner uses
real Alter spawns and records per-depth queue, retry, token, and failure data;
its depth-8 branching case reaches 17 nodes. These fixture runs validate the
benchmark setup. Model comparisons and quality measurements start in 4.3.

#### 4.3 Run paired comparisons — complete

- Compare direct local inference, direct cloud inference, an attached OpenCode
  session, and a newly spawned session on the same eligible tasks. Hold model,
  prompt, output limit, and permissions constant where possible; identify
  cases where an executor changes the available tools or context.
- Compare deterministic candidate order, lowest estimated cost, and adviser
  selection. For network routers, compare adviser choices with a predefined
  deterministic classifier and the configured failure fallback separately.
- Run a small cost-capped pilot, then fix repetitions and acceptance thresholds
  before the main run. Randomize condition order and report cold and warm runs
  separately. Publish median and p95 end-to-end latency, routing overhead,
  estimated API-equivalent cost, success, quality, wrong-route rate,
  invalid-choice rate, and payload-isolation failures with sample counts.

The versioned comparison plan completed an 8-call pilot and a 48-call main
matrix across local direct, cloud direct, attached OpenCode, and fresh
OpenCode. A separate replay compared candidate order, lowest estimated cost,
and local Laya selection; seven live network signals compared Laya with a
fixed classifier, and six scripted failures measured fallback behavior. The
depth-8 chain and 17-node branch fixtures were rerun with raw homes retained.
The measured harness and quality rates missed the frozen targets, and the
Laya router missed one held-out sales signal. These are inputs to 4.4. See
[benchmark results](benchmarks/RESULTS-2026-09-24.md) for counts, costs,
latency, model versions, limitations, and reproduction commands.

A follow-up OpenCode subscription run with GPT-6 Luna and Grok 4.6 met the
frozen text success and quality targets on all 48 paired calls. Both models
also passed a 16-call image supplement using provider-valid 64 × 64 fixtures,
and all four model-backed depth-8 trees reached their expected nodes without
failed calls. On seven network signals per model, both chose valid routes
without payload leaks. Grok added text to seven of 26 nested node answers,
so exact output adherence remains a 4.4 refinement target. Per-run subscription
cost is unknown. See [frontier benchmark results](benchmarks/RESULTS-FRONTIER-2026-09-24.md).

#### 4.4 Refine and verify — complete

- Use a development split to adjust candidate context, capability, residency,
  output-limit, and price metadata, then selection and fallback rules. Do not
  tune against the held-out cases.
- Re-run the same matrix on held-out tasks. Accept a change only when its
  latency or cost gain does not reduce the agreed success and quality targets,
  violate hard routing constraints, or deliver a payload to an unchosen worker.
  Record regressions and the final supported route expectations in the docs.

The development split selected an explicit frontier candidate policy with
declared context, image, output, and API-equivalent price metadata. Unknown
residency remains a hard exclusion when a request specifies a residency.
The ten-call development pilot and 40-call held-out text/image matrix passed;
the routed condition selected Luna on all eight held-out calls, met all frozen
targets, and had lower observed latency than attached Grok without a quality
loss. Scripted router isolation and fail-closed checks passed 13/13. A planner
fix also excludes unknown image support and rejects output estimates above the
request cap. Grok's strict-output regression and the failed local/Mistral
quality targets remain documented limitations. See [refinement results](benchmarks/RESULTS-REFINEMENT-2026-09-25.md)
and [supported routes](docs/inference-routing.md).

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
