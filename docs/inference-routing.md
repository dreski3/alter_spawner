# Ordered model candidate contract

This document defines the v1 catalog contract for ordered model alternatives
and the remaining request-planner work.

## Configuration ownership

- Project `providers` define how a provider is reached: protocol, endpoint,
  credential reference, and supported model inputs and output limits.
- A catalog Alter defines its own ordered list of candidate provider/model
  pairs. In v1, all candidates use the Alter's single `executor`; candidates
  do not select different executors. Candidate lists are per Alter; reusable
  named routing profiles are out of scope.
- Runtime tries the candidates in order after retryable failure, subject to
  retry and replay-safety rules. Residency and cost-based eligibility belong
  to the later request-planner step.

Provider definitions contain references to credentials, never credential
values. V1 does not yet enforce residency or cost requirements.

## Catalog shape

```json
{
  "name": "reviewer",
  "description": "Reviews a proposed change.",
  "executor": "llm",
  "model_candidates": [
    { "id": "local", "model": "mlx/qwen" },
    { "id": "cloud", "model": "openai/gpt-4.1" }
  ]
}
```

Each candidate's `model` remains the existing `provider/model` reference. The
provider is resolved from the project's provider registry or the existing
OpenCode compatibility catalog. The Alter's single `executor` runs every
candidate. Candidate `id` provides a stable name for traces and configuration
errors; it does not grant authority. Selecting a different executor per
candidate is left to the later request-planner step.

Candidate field names are implemented in v1. Candidates must use the same
executor as their Alter. Automatic fallback across multiple candidates is
supported for `llm` and `opencode`; other executors may use a single candidate
until they can report whether an attempt may have caused side effects.

## Selection and fallback semantics

1. Consider candidates in manifest order. Candidate zero is the primary model.
2. Apply `same_harness_retries` to the primary candidate, then
   `fallback_retries` attempts to each alternative in order.
3. For `llm`, retry transport errors, timeouts, HTTP 408/425/429, server errors,
   empty output, and output-contract failures. Provider configuration errors
   and other 4xx responses skip the remaining attempts for that candidate and
   advance to the next candidate, if any. Budget exhaustion and cancellation
   stop the plan.
4. For `opencode`, continue only while no tool activity has been observed.
   Once a tool call starts, stop retries and candidate fallback because replay
   could repeat side effects. Record candidate id, model, retry reason, tool
   activity, usage, and outcome for every attempt.

The current `model` and `fallback_model` manifest fields continue to work when
`model_candidates` is absent. They cannot be combined with the candidate list;
catalog validation rejects that ambiguous configuration.

An explicit call-site `--model` pins a catalog run to that model and does not
use the manifest candidate list. Repeatable `--model-candidate id=provider/model`
flags supply a candidate list when creating or updating a catalog entry; an
explicit candidate list takes precedence over the list in the selected catalog.

## Failure and replay safety

Fallback must account for whether the previous attempt may already have caused
side effects. A direct completion is tool-less, so a transport failure can
usually advance to another candidate, though it may still incur provider cost.
A tool-using session can time out or fail after a tool has run; automatically
starting another session may repeat that action.

For direct `llm` calls, connection failures, timeouts, HTTP 408/425/429, server
errors, empty output, and output-contract failures are retryable. Provider
configuration errors and other 4xx responses skip the remaining attempts for
that candidate and move to the next candidate if one is configured. Budget
exhaustion and cancellation stop the plan. A transport timeout can still incur
provider cost even when retrying is safe from tool side effects.

For OpenCode, failed attempts can retry or fall back while no tool activity has
been observed. Once a tool event begins, the engine stops the candidate plan
because replay could repeat side effects.

Tool activity is detected from OpenCode tool events. Candidate failover for
Codex, Grok, or host-bound executors remains unavailable until those adapters
can report enough information to make replay safety explicit.

## Authority and trace requirements

The effective model grants for a run include every candidate and remain bounded
by the inherited authority ceiling. Selecting an alternative never widens that
ceiling. Each attempt records candidate id, model, reason, tool activity,
outcome, and usage. The result records the Alter's executor and candidate list.
Credentials and secret values are excluded from traces.

## Decisions to close before implementation

- Which provider/model facts are mandatory, optional, or inferred from the
  compatibility catalog.
- Cost estimation rules across input, output, cached, and reasoning tokens.
- The exact meaning of local, remote, and unknown residency.
- Whether the retryable HTTP status set and authentication behavior need
  provider-specific overrides.
- How Codex, Grok, and host-bound adapters can report replay safety before
  supporting multi-candidate fallback.
