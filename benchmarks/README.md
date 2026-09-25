# Routing benchmark task set v1

`task-set-v1.json` fixes the inputs and labels for roadmap 4.2. Its SHA-256 is
printed by `npm run benchmark:validate` and by both fixture runners. Keep that
hash with later model runs, along with model versions, executor settings, price
sources, raw run homes, and the analysis report.

The set has ten task cases across classification, JSON extraction, reasoning,
image input, and tool use. `scoreTask` reports harness success separately from
answer quality. Exact, JSON-field, and tool-use checks score automatically.
The open reasoning case produces a `blindReviewPacket` containing the prompt,
answer, and criteria without the model or executor; a reviewer rates each
criterion 0 or 1 and `scoreBlindReview` averages them. Development and held-out
labels are fixed in the data file.

Thirteen router cases label billing, technical, sales, and the uppercase
capability route. They include ambiguous signals, invalid choices, adviser
errors, timeouts, explicit fallbacks, and unique payload canaries. The router
fixture runner uses a scripted adviser to check routing and isolation mechanics:
only the signal reaches the adviser, only the chosen worker receives the exact
payload, and `decision.json` contains no payload or canary. These checks do not
measure a model's routing accuracy; that comparison belongs to 4.3.

Eight nested workloads run actual Alter spawns at maximum depths 1, 2, 4, and
8. Each depth has a chain and a branching tree. A branching case has one spine
child and one side leaf at each level, so the depth-8 case has 17 nodes. The
deep cases inject one retry and one terminal failure. Each report lists nodes,
attempts, retries, queue wait, admission time, tokens, and failed nodes by
depth. `queue_ms` measures time after a concurrency admission is first denied;
`admission_ms` also includes ledger and lock work. Whole-tree wall time is
separate from summed node wall time.

Run the local fixture checks with:

```sh
npm run benchmark:validate
npm run benchmark:router-fixtures
npm run benchmark:nested-fixtures
```

Run either fixture script directly with `--keep-runs` to retain its temporary
projects and print `run_home` paths in the JSON output. Without that option,
temporary projects are removed after their metrics are collected. The JSON
reports omit prompts and payloads. The retained run homes contain the normal
Alter records and should be treated as raw benchmark inputs.
For durable nested run homes, add `--output-root benchmarks/results/nested-projects`
with `--keep-runs`; the named per-case directories must not already exist.

The image fixtures are 16 × 16 PNGs with a single dominant color. Router-to-
router edges remain excluded because the current network executor rejects
them; add multi-router labels when that execution path exists.

## Paired comparison

`comparison-plan-v1.json` fixes the model references, provider prices, cost
caps, seed, case matrix, repetitions, and acceptance thresholds. Run the pilot
before the main matrix:

```sh
npm run benchmark:compare -- --pilot --output benchmarks/results/pilot
npm run benchmark:compare -- --main --pilot-report benchmarks/results/pilot/report.json --output benchmarks/results/main
```

The runner uses the local Ollama model and the Mistral API credential already
configured in OpenCode. It saves each raw Alter home, a JSONL record per call,
blind review packets, a separate map from review IDs to conditions, and a
summary report under `benchmarks/results/`. That directory is ignored by Git.
The runner stops on unknown positive-price usage or a cost cap breach. Pilot
and main must use the same plan and task set hashes.

Score the blind packets without opening `blind-map.json`, then write a JSON
object from review ID to one 0/1 rating per criterion. Apply those ratings with:

```sh
npm run benchmark:apply-ratings -- benchmarks/results/main benchmarks/results/main/blind-ratings.json
```

This creates `report-reviewed.json`. The first main text matrix excludes the
image and tool cases because its four executor conditions do not share those
capabilities. `cloud-direct`, `cloud-attached`, and `cloud-fresh` use the same
Mistral model but different context and session behavior. The local condition
uses a different model, so its quality comparison is exploratory.

For routing comparisons, set `LAYA_MLX_PYTHON` and `LAYA_MLX_MODEL_DIR` to the
installed local checkpoint and run:

```sh
npm run benchmark:router-compare -- --output benchmarks/results/router
npm run benchmark:candidate-policies -- benchmarks/results/main
```

The router comparison runs the same seven labeled signals through Laya and a
fixed keyword classifier, plus six scripted failure and fallback cases. The
router output keeps each raw network run under its own `projects/` or
`fallback-projects/` directory. A fresh output directory is required for each
run. The candidate policy comparison replays ordered, lowest-cost, and Laya adviser
choices against the direct model observations from the completed main matrix;
it adds measured route time but makes no additional model request per policy.
These outputs retain sample counts and distinguish measured runs from replay.
See [the September 2026 result](RESULTS-2026-09-24.md) for the first run.

## OpenCode subscription comparison

`comparison-plan-frontier-v1.json` repeats the same six text cases and two
repetitions with `openai/gpt-6-luna` and `xai/grok-4.6`. Each model runs once
with an attached OpenCode server and once in fresh OpenCode sessions per task.
The subscription's per-run billed amount is unavailable, so the plan reports
unknown dollar cost. It bounds the number of calls, wall time, and tokens per
call instead.

```sh
npm run benchmark:compare -- --pilot --plan benchmarks/comparison-plan-frontier-v1.json --output benchmarks/results/pilot-frontier
npm run benchmark:compare -- --main --plan benchmarks/comparison-plan-frontier-v1.json --pilot-report benchmarks/results/pilot-frontier/report.json --output benchmarks/results/main-frontier
```

The model-backed nested run uses the same two models on depth-1 pilot chains,
then depth-8 chains and branches. The host creates each child after its parent
model call; the models answer a fixed short prompt at each node. The resulting
raw Alter homes contain per-depth queue, attempt, token, and failure data.

```sh
npm run benchmark:frontier-nested -- --pilot --output benchmarks/results/nested-frontier-pilot
npm run benchmark:frontier-nested -- --main --pilot-report benchmarks/results/nested-frontier-pilot/report.json --output benchmarks/results/nested-frontier-main
```

Both models advertise image input. The original 16 × 16 image fixtures are
below Grok's 512-pixel minimum, so `comparison-plan-frontier-image-v2.json`
uses 64 × 64 solid-color fixtures. The plan and report record this override
and the PNG hashes. It is a separate matrix because the source pixels differ
from the original task-set images, while the labels and prompt stay the same.

```sh
npm run benchmark:compare -- --pilot --plan benchmarks/comparison-plan-frontier-image-v2.json --output benchmarks/results/pilot-frontier-image
npm run benchmark:compare -- --main --plan benchmarks/comparison-plan-frontier-image-v2.json --pilot-report benchmarks/results/pilot-frontier-image/report.json --output benchmarks/results/main-frontier-image
```

See [the frontier result](RESULTS-FRONTIER-2026-09-24.md) for the observed
text, image, and depth-8 outcomes.

The same OpenCode models can also act as network route advisers. The route
prompt contains the labeled signal and allowed route descriptions; a separate
worker receives the payload only after the host validates the model's route ID.
Run the two-call pilot before the fourteen-call labeled matrix:

```sh
npm run benchmark:frontier-router -- --pilot --output benchmarks/results/router-frontier-pilot
npm run benchmark:frontier-router -- --main --pilot-report benchmarks/results/router-frontier-pilot/report.json --output benchmarks/results/router-frontier-main
```

## Refinement verification

`refinement-plan-frontier-v1.json` freezes a lowest-cost candidate route after
the development split. Its pilot uses development extraction and image cases;
its main matrix uses only held-out text and image cases, with two repetitions
across the four original OpenCode conditions plus the routed condition. The
64 × 64 image overrides and API-equivalent model metadata are part of the
versioned plan. Subscription charges remain unknown.

```sh
npm run benchmark:compare -- --pilot --plan benchmarks/refinement-plan-frontier-v1.json --output benchmarks/results/refinement-pilot
npm run benchmark:compare -- --main --plan benchmarks/refinement-plan-frontier-v1.json --pilot-report benchmarks/results/refinement-pilot/report.json --output benchmarks/results/refinement-main
npm run benchmark:apply-ratings -- benchmarks/results/refinement-main benchmarks/results/refinement-main/blind-ratings.json
node benchmarks/run-router-cases.mjs > benchmarks/results/refinement-router-fixtures.json
npm run benchmark:verify-refinement -- benchmarks/results/refinement-pilot benchmarks/results/refinement-main benchmarks/results/refinement-router-fixtures.json
```

Rate every `blind-packets.json` answer before opening `blind-map.json`.
The final command checks hashes, split boundaries, completion, frozen targets,
quality regressions, the observed latency gain, selected route, and scripted
payload isolation; it writes `verification.json` and exits nonzero on a failed
gate. See [the refinement result](RESULTS-REFINEMENT-2026-09-25.md) for the
completed run, regressions, and supported route scope.
