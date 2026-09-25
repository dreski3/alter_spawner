# Routing refinement, 25 September 2026

The task set SHA-256 is
`0d72f21de4e56253e6b4a8e9da6538e3de4fdd5cc512e381b0a3c68b77cb0105`.
The frozen refinement plan SHA-256 is
`f046a7debd10ab0dec75ad5ec78837b34e53830ee93063e461913cc43cddf2c0`.
The plan retains the 4.3 OpenCode models, prompts, 12,000-token request cap,
attached and fresh session conditions, two repetitions, and the corrected
64 × 64 image fixtures. The pilot used only development cases; all four main
cases were held out. Model references remain mutable and have no provider
digests.

## Development decision

The 4.3 development split had six text observations per model/session
condition. All four conditions passed every automatic check. Attached Luna's
median wall time was 4.02 s, versus 5.41 s for attached Grok. The local and
Mistral direct routes missed the frozen 80% harness and 70% automatic-quality
targets, so they were not eligible for this refinement. The fixed network
classifier was faster than model advisers on development signals, but its
4.3 held-out canary failure prevents accepting it as the supported router.
No rule was adjusted using a held-out label.

The new candidate policy declares each frontier model's text/image inputs,
context and output ceilings, and short-context API-equivalent prices from the
OpenCode catalog cached on 25 September. `lowest_cost` selects Luna among
eligible OpenCode candidates, with Grok next in the deterministic fallback
order. The benchmark disables execution fallback to keep each call paired with
one model; a separate retryable-failure integration test verifies fallback
order. Neither provider has a verified residency declaration in this plan.
Requests that require a residency must supply verified metadata and will fail
closed when it is absent. The benchmark does not establish tool-task quality.

The 10-call development pilot completed, with 100% harness and automatic
quality checks across all five conditions. The routed condition chose Luna on
both development cases. The policy was then left unchanged for the main run.

## Held-out verification

The main matrix completed all 40 calls: classification, strict JSON
extraction, reasoning, and image input, each repeated twice under five
conditions. Ten reasoning answers were rated from condition-blind packets;
one Grok answer received 3/4 because it did not mention containment or
mitigation. Each condition has eight observations.

| Condition | Median / p95 wall time | Harness success | Reviewed quality | API-equivalent cost, eight calls |
| --- | ---: | ---: | ---: | ---: |
| Luna attached | 4.38 / 7.83 s | 8/8 | 100% | $0.0003066 |
| Luna fresh | 4.59 / 5.99 s | 8/8 | 100% | $0.0003127 |
| Grok attached | 6.13 / 9.16 s | 8/8 | 96.9% | $0.0096260 |
| Grok fresh | 6.47 / 16.31 s | 8/8 | 100% | $0.0110200 |
| Routed lowest cost | 4.29 / 5.10 s | 8/8 | 100% | $0.0003032 |

The routed calls selected Luna 8/8 times and made one model attempt each.
Median route planning took 0.097 ms. Against the paired attached Grok calls,
the routed calls were faster in all eight cases, with a median matched
difference of −1.96 s. The median matched difference against attached Luna
was −0.34 s, though two of eight routed calls were slower by 0.18 and 0.41 s.
This small live sample supports the route expectation but does not establish a
stable latency advantage over direct Luna.

All conditions exceeded the frozen 80% harness and 70% automatic-quality
targets. The routed condition had no wrong selections or observed quality
loss. The 13 scripted network cases passed their selection, fail-closed,
fallback, and payload-isolation assertions, including six held-out cases.
Planner tests also covered image capability uncertainty, residency, context,
output ceilings, price ranking, inherited authority, and retryable fallback.
`verification.json` accepted the route on the frozen inputs and checks.

The API-equivalent prices are catalog assumptions for short contexts, not
subscription charges. Actual billed cost is unknown. The network isolation
check uses scripted workers; the separate 4.3 live frontier adviser run had
7/7 correct routes per model with no canary leak. Image results use the 64 × 64
fixtures, and the tool task remains outside the common matrix. Grok's earlier
seven non-exact nested `DONE` answers remain a regression for strict-output
workloads; prefer Luna for those cases until independently reverified.

Raw plans, run homes, blind packets, ratings, reviewed analysis, and the
verification gate are in ignored `benchmarks/results/` directories named
`refinement-frontier-pilot-20260925` and
`refinement-frontier-main-20260925`. The scripted router report is
`refinement-router-fixtures-20260925.json` in the same directory.
