# In-process request routing

An Alter can define ordered model candidates. Each candidate names a
`provider/model` and may name an executor. Without a candidate executor, it
inherits the Alter's `executor`, or the caller's default. The planner selects
eligible model and executor pairs before the retry plan begins.

## Configuration

```json
{
  "name": "reviewer",
  "description": "Reviews a proposed change.",
  "model_candidates": [
    { "id": "local", "model": "local/reviewer", "executor": "llm" },
    { "id": "cloud", "model": "cloud/reviewer", "executor": "opencode" }
  ],
  "routing": {
    "strategy": "lowest_cost",
    "allowed_residencies": ["local", "eu"],
    "required_context_tokens": 4096,
    "estimated_output_tokens": 512,
    "max_estimated_cost_usd": 0.02
  }
}
```

Candidate IDs must be unique. The same model may appear under different
executors. Candidates may use `llm`, `opencode`, and `codex`. xAI provider use,
including native Grok CLI execution, is paused while authentication refresh
failures are investigated. Use OpenAI models through OpenCode for now.
The existing `model` and `fallback_model` fields remain available when
`model_candidates` is absent.
An explicit `--model` pins a catalog run to one model.

Project `.alters/config.json` owns provider metadata. Metadata can be set on a
provider or overridden by a model:

```json
{
  "providers": {
    "local": {
      "protocol": "openai-compatible",
      "base_url": "http://127.0.0.1:11434/v1",
      "api_key_env": null,
      "residency": "local",
      "models": {
        "reviewer": {
          "input": ["text"],
          "context_tokens": 8192,
          "max_output_tokens": 1024,
          "cost": { "input_per_million": 0, "output_per_million": 0 }
        }
      }
    },
    "cloud": {
      "residency": "eu",
      "models": {
        "reviewer": {
          "input": ["text", "image"],
          "context_tokens": 128000,
          "capabilities": ["vision"],
          "cost": { "input_per_million": 2, "output_per_million": 8 }
        }
      }
    }
  }
}
```

Direct `llm` candidates also need a supported `protocol` and endpoint or
credential configuration. OpenCode candidates may use metadata-only provider
entries and continue resolving their actual endpoint through OpenCode.
Credential values stay in the host environment. Residency values are project
declarations; the planner does not independently verify a provider's location.

## Eligibility and ranking

The planner checks inherited model and executor authority, the executor's
sandbox and image support, declared model inputs, allowed residencies,
context limits, required capabilities, and estimated cost. A requirement with
unknown metadata makes that candidate ineligible. A request that needs file,
shell, web, or nesting permissions cannot select the tool-free `llm` executor.
`tools` is a built-in capability of a tool-enabled agent session; other
capability names come from provider metadata.

The planner estimates input tokens as one token per four UTF-8 bytes of prompt.
Set `required_context_tokens` when a request needs a firm context allowance.
Estimated cost uses the input estimate and `estimated_output_tokens`, the run's
token cap, or the model's declared output limit. Cost metadata is in USD per
million tokens. These figures are planning estimates, not billing totals.

`ordered` is the default strategy and preserves eligible manifest order.
`lowest_cost` sorts eligible candidates by estimated cost, breaking ties by
manifest order. It requires usable cost metadata. `max_estimated_cost_usd`
excludes candidates above the specified estimate. If none remain, the request
fails before a home is created.

The CLI accepts repeatable `--model-candidate id=provider/model` and
`--model-candidate id=executor:provider/model` flags. A call can set routing
requirements with `--route-strategy`, `--route-residency`,
`--route-context-tokens`, `--route-output-tokens`, `--route-max-cost`, and
`--route-require-capability`. These flags also work with `mind catalog save`.

## Attempts and safety

After selection, the existing retry policy applies to the chosen candidate:
`same_harness_retries` repeats the first eligible route, and
`fallback_retries` allows attempts on each later eligible route. The planner
does not treat a failed request as a new policy decision.

Direct `llm` calls can advance after transport failures, timeouts, HTTP
408/425/429 and server errors, empty output, or output contract failures.
Provider configuration errors and other 4xx responses skip retries of that
candidate. Cancellation and token budget exhaustion stop the plan.

OpenCode and Codex can advance only while no tool activity has been
observed. Once a tool call starts, retry and fallback stop because another
session could repeat its effects. The scaffold includes the files needed by
every configured agent executor so a later fallback or rerun can use its own
home. Host-bound executors do not support automatic multi-candidate fallback.

Native Grok and xAI provider routing are recorded as follow-up work in the
roadmap. A local CLI run saw authentication refresh failures; check both the
native CLI and OpenCode paths before enabling xAI routes again.

The run result records the planner's eligibility decisions, selected candidate,
and each attempt's candidate, model, executor, outcome, and usage. The Alter
home retains its original candidate list and routing policy so a rerun can
plan against the new request and current provider metadata.
