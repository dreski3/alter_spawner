# OpenCode subscription benchmark, 24 September 2026

The fixed text task set SHA-256 is
`0d72f21de4e56253e6b4a8e9da6538e3de4fdd5cc512e381b0a3c68b77cb0105`.
The frontier text plan SHA-256 is
`c49eac6337b9dc3c0825ebe8eb5ba2363fcf63c3ddc6b9e62160b9b9599c9678`.
OpenCode version was `1.18.30`. The model references were
`openai/gpt-6-luna` and `xai/grok-4.6`; the providers did not expose immutable
model digests. Each model ran through an attached server and fresh OpenCode
sessions, with the same six text tasks, prompts, output limit, and two
repetitions as the earlier comparison.

The text pilot completed 8/8 calls and the main matrix completed 48/48.
Each condition has 12 observations. All 40 automatically scored answers
passed, including the strict JSON extraction cases. One reviewer scored the
eight open reasoning answers from packets without condition IDs.

| Condition | Median / p95 wall time | Harness success | Quality after blind review |
| --- | ---: | ---: | ---: |
| GPT-6 Luna attached | 4.73 / 7.17 s | 12/12 | 100% |
| GPT-6 Luna fresh | 4.17 / 9.54 s | 12/12 | 100% |
| Grok 4.6 attached | 5.52 / 12.53 s | 12/12 | 95.8% |
| Grok 4.6 fresh | 5.58 / 12.54 s | 12/12 | 97.9% |

The median matched fresh-minus-attached latency was 36 ms for Luna and 98 ms
for Grok across 12 pairs per model. The small paired deltas and the wider p95
times mean this run does not establish a reliable session-speed advantage.
The earlier Mistral OpenCode run had 8/12 harness successes per condition,
with 64.6% quality after review, on the same six tasks. Its extraction failures
were fenced JSON; both frontier models returned valid JSON in this run.

These models were accessed through paid OpenCode subscriptions. Per-run billed
amounts and comparable API-equivalent prices were unavailable, so dollar cost
is `null`, not zero. The runs were bounded by call count, wall time, and token
limit. Model differences, live service conditions, and only 12 observations
per condition limit the strength of latency and quality comparisons.

Raw text runs, blind packets, ratings, and reviewed analysis are under the
ignored `benchmarks/results/main-frontier-20260924/` directory. The matching
pilot is under `benchmarks/results/pilot-frontier-20260924/`.

## Model-backed nested Alters

The two depth-1 pilot chains passed. The main nested run executed 52 model
calls across a depth-8 chain and a depth-8 branching tree for each model. The
host spawned each next Alter after a real OpenCode call, retaining raw homes
and per-depth queue, token, attempt, and failure data. This measures model
execution inside deep trees; the models did not choose which child to spawn.

| Model and tree | Nodes / attempts | Exact `DONE` answers | Tokens | Root wall time | Failed nodes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Luna chain, depth 8 | 9 / 9 | 9 / 9 | 3,555 | 42.0 s | 0 |
| Luna branch, depth 8 | 17 / 17 | 17 / 17 | 6,869 | 107.8 s | 0 |
| Grok chain, depth 8 | 9 / 9 | 7 / 9 | 10,258 | 60.2 s | 0 |
| Grok branch, depth 8 | 17 / 17 | 12 / 17 | 19,296 | 115.0 s | 0 |

Grok's seven non-exact answers included extra node-description text, while
the Alter calls themselves succeeded. The branching cases used a one-node
concurrency limit and accumulated queue time across descendants; summed node
time and queue time should not be read as root wall time. Each node had a
3,000-token ceiling. Raw results are in the ignored
`benchmarks/results/nested-frontier-main-20260924/` directory, with its pilot
in `nested-frontier-pilot-20260924/`.

## Image supplement

OpenCode advertises image input for both models. The original 16 × 16 square
contains only 256 pixels; a Grok probe rejected it because the provider
requires at least 512 pixels. A separate plan kept the same red/blue labels
and prompt while using generated 64 × 64 solid-color PNGs. Their SHA-256
values are `6f7ffeeb88929a8a2e34ea973c871f069be70cbaf1459fff345db59453934435`
for red and `e8ef205b78cd3e66f9688d35ac2c073a60e2a904b98df61ef538376d9ae1305f`
for blue. The image plan SHA-256 is
`7cf7d79359732422206d58bc9b0975a601d161a23eb580498365c6ec055499a1`.

The corrected image pilot completed 4/4 calls. The main matrix completed
16/16, with all four conditions correctly labeling all four images each.

| Condition | Median / p95 wall time | Harness success | Exact color quality |
| --- | ---: | ---: | ---: |
| GPT-6 Luna attached | 3.46 / 3.60 s | 4/4 | 4/4 |
| GPT-6 Luna fresh | 4.35 / 4.53 s | 4/4 | 4/4 |
| Grok 4.6 attached | 6.61 / 7.96 s | 4/4 | 4/4 |
| Grok 4.6 fresh | 5.86 / 6.49 s | 4/4 | 4/4 |

The original small-image pilot remains in ignored
`benchmarks/results/pilot-frontier-image-20260924/` as a record of the
provider validation error. Corrected raw image runs and fixture hashes are in
`pilot-frontier-image-v2-20260924/` and `main-frontier-image-v2-20260924/`.

## Network route advisers

A two-call pilot and fourteen-call main matrix used the models as advisers for
the same seven labeled network signals. Each adviser saw only the routing
signal and allowed route descriptions. The host validated its route ID before
forwarding the unchanged canary payload to one worker.

| Adviser | Valid routes | Wrong routes | Payload isolation failures | Median / p95 network time | Adviser tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-6 Luna | 7/7 | 0 | 0 | 4.28 / 8.18 s | 2,405 |
| Grok 4.6 | 7/7 | 0 | 0 | 6.04 / 13.06 s | 8,893 |

The earlier local Laya run chose one wrong route out of seven and had a
0.45-second median network time. The frontier models improved route accuracy
on this small set but took longer. The existing scripted invalid-choice,
error, and timeout fixtures still provide the fallback and fail-closed checks;
they were not caused by these frontier models. Raw adviser and network homes
are under the ignored `benchmarks/results/router-frontier-main-20260924/`
directory, with the pilot in `router-frontier-pilot-20260924/`.
