# Metabolism

Metabolism is the project's name for background work that improves future
execution without becoming part of the user's current conversation. It joins
graphs, recurring oscillations, memory, capability policies, and maintenance
or reward tasks.

The purpose is to let a durable parent agent consolidate memory, revisit
unfinished goals, inspect resource use, and carry forward selected outcomes
without exposing every maintenance step as conversational context.

## Building blocks

- A **spike** is one execution of an Alter or built-in graph. It records a
  result, resource use, provenance, and an auditable run record.
- A **graph** is a validated dependency structure of spikes. Ready branches
  can run in parallel, and downstream nodes consume declared upstream results.
- An **oscillation** is a recurring schedule of spikes grouped into phases.
  Spikes within a phase run concurrently; later phases can depend on earlier
  outcomes.

## Runtime guarantees

Oscillation definitions are versionable project configuration. Last-run state,
cycle logs, skip reasons, and unattended grants are runtime state. A refractory
lock prevents concurrent or overly frequent cycles.

No unattended capability is granted by default. Daemon policy remains separate
from approval made in an interactive conversation. Graph memory reads are
stable within a cycle, and writes made by curation become visible to the next
cycle.

The built-in maintenance pattern is deliberately constrained: a
`memory-manager` Alter inspects a bounded memory snapshot and proposes an
exact operation plan. The capability system validates and applies the plan
atomically. The same pattern can support reward evaluation, goal recovery,
tool improvement, and consolidation: planning is isolated, effects are
explicit, and every cycle is auditable.
