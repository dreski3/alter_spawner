# Embedding Alter Spawner

Use `@mind/core` when another application owns the chat interface, approval UI,
scheduler, or agent identity. Use the self-contained `mind` package when a
process boundary and CLI are sufficient.

## Initialize a project

```js
import { initMind } from "@mind/core";

const initialized = initMind("/srv/agents/research", {
  name: "research",
});

console.log(initialized.agentId);
```

The included default profile produces the same project shape as `mind init`.
Pass `profileDir` to own the initial instructions, catalogs, configuration, and
harness settings. Reinitialization requires `force: true`; identity is preserved
unless `newIdentity: true` is explicit.

## Execute work

```js
import { createSpawnOptions, spawnAlter } from "@mind/core";

const controller = new AbortController();
const run = await spawnAlter(
  projectRoot,
  createSpawnOptions({
    catalog: "researcher",
    prompt: "Find the relevant implementation constraints.",
  }),
  {
    signal: controller.signal,
    onEvent(event) {
      transport.publish(event);
    },
  },
);

if (!run.result.ok) throw new Error(run.result.contract_error ?? "Alter failed");
```

Use `runAlterGraph` for dependency graphs. Supply `onProgress` for node state
and `onEvent` for streamed Alter events. Use an `AbortSignal` for request
cancellation; cancellation propagates to active harness work and does not spend
the retry policy.

## Register a harness

```js
import { registerHarness } from "@mind/core";

registerHarness("service", {
  needsAgentHome: false,
  supportsRetry: true,
  async run(home, prompt, options) {
    return serviceAdapter.complete({ prompt, signal: options.signal });
  },
});
```

A harness returns the normalized `AlterResponse` contract declared by the
package. Set `needsAgentHome: false` only if it reads no generated instructions
or sandbox configuration from disk. Such an executor cannot accept filesystem,
shell, web, or nesting grants.

## Bind host capabilities

Build capability definitions in the host, create a registry, then register the
`function` and/or `capability` harness adapters. A function executor accepts only
operations declared with `approval: "never"`. An approval executor pauses on an
opaque request ID and resumes only after the host records an explicit decision.

Never derive executable commands from model input or project manifests. Register
fixed executable vectors or schema-validated handlers in trusted host code. Keep
interactive grants separate from unattended daemon grants.

## Run oscillations

Use `writeOscillation` to validate and persist a definition, `runOscillation`
when the host supplies spike execution, or `runDaemonTick` to operate registered
minds. The long-running `runDaemon` is a small loop over the same tick contract;
deployment can instead invoke `mind daemon --once` from launchd, cron, or a
service timer.

## Host responsibilities

- Keep credentials and capability implementations outside authored project data.
- Choose and persist the user-facing agent identity.
- Surface approval lifecycle events and cancellation.
- Decide which metabolic outcomes enter the agent's future context.
- Monitor failed spikes, refractory skips, incomplete runs, token usage, and
  storage quotas.
- Pin compatible package versions until the framework reaches `1.0.0`.
