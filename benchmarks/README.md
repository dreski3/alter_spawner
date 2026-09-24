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

The image fixtures are 16 × 16 PNGs with a single dominant color. Router-to-
router edges remain excluded because the current network executor rejects
them; add multi-router labels when that execution path exists.
