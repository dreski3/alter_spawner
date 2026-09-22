# Architecture

Alter Spawner separates the identity a person interacts with from the isolated
processes that perform and maintain its work.

## Vocabulary

- **Agent**: the durable, user-facing entity. It owns identity, policy, and the
  conversational relationship. It does not need every internal maintenance
  detail in its active context.
- **Alter**: one isolated instantiation of processing for a bounded task. An
  Alter may use inference, a deterministic function, an approval-gated host
  capability, or another registered harness.
- **Spike**: one execution of an Alter or built-in graph. A spike has a result,
  resource usage, provenance, and an auditable run record.
- **Graph**: a validated dependency structure of spikes. Ready branches run in
  parallel; downstream prompts can consume declared upstream results.
- **Oscillation**: a recurring schedule of spikes grouped into phases. Spikes
  in one phase run concurrently; later phases can be gated by earlier outcomes.
- **Metabolic layer**: the oscillations and graphs that regulate memory,
  resource budgets, goal recovery, reward signals, and maintenance. See
  [Metabolism](metabolism.md) for its execution model and guarantees.
- **Harness**: the execution adapter behind an Alter. The built-ins cover
  OpenCode and Codex sessions plus direct tool-free LLM calls; hosts can
  register others.
- **Capability**: a fixed operation supplied by the host. Trusted deterministic
  operations and approval-gated operations use different executors so a model
  cannot silently widen its authority.

## Runtime boundaries

The project root is the durable boundary. Authored configuration lives under
`.alters/`: catalogs, oscillation definitions, and limits. Runtime state is
kept separately: run homes, graph traces, tree ledgers, oscillation state, and
memory stores.

An Alter receives only the files, tools, catalogs, and host capabilities
declared for it. A nestable Alter can create descendants, but tree-wide node,
token, concurrency, and depth guards constrain recursive decomposition. Its
runtime authority ceiling is outside its writable home and each descendant is
validated against the immediate parent's effective filesystem, shell, web,
model, executor, capability, catalog, and depth permissions.
Capability registrations remain in the host process and are never loaded from
project-authored files.

## Execution flow

1. The host or daemon selects an Alter, graph, or due oscillation.
2. Catalog configuration is resolved and explicit call-site options are applied.
3. Tree limits admit the work before a run home is created.
4. The selected harness runs in the Alter's declared isolation boundary.
5. Output contracts classify the result; retry and fallback policy handle
   eligible failures.
6. The result, attempts, usage, dependencies, and provenance are persisted.
7. Memory curation is deferred until graph computation finishes, so a cycle
   sees a stable memory snapshot and its writes become visible next cycle.

## Metabolic execution

See [Metabolism](metabolism.md) for the execution model, runtime guarantees,
and maintenance pattern.

## Design invariants

- User-facing identity outlives any Alter or session.
- Authored definitions and runtime state do not share a lifecycle.
- Project data cannot register trusted host code.
- An Alter cannot grant itself more filesystem, shell, catalog, or capability
  access.
- Graph memory reads are stable within a cycle.
- Scheduled maintenance is observable and bounded even when it is not injected
  into the agent's conversational context.
