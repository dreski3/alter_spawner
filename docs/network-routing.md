# Optional network routing

A network can route a principal request through a router Alter. Existing direct
spawns, graphs, event components, and deterministic execution remain available.
The router receives a routing signal and a separate payload. Its adviser sees
the signal and route descriptions, selects one allowed route ID, and never sees
the payload. The router then spawns one child Alter or host capability node and
passes the payload to that child.
The runnable [Laya router example](../examples/laya-router/README.md) includes
a saved network and catalog definitions.

## Network definition

The principal is the network's `ego`. This example has four Alter components:
the router and three workers. The router can also name a capability component
in its routes.

```json
{
  "id": "service",
  "name": "Service dispatch",
  "ego": { "enabled": true, "catalog": "principal", "spawn": ["router"] },
  "interfaces": [],
  "components": [
    {
      "id": "router", "role": "internal", "catalog": "router",
      "triggers": [{ "type": "manual" }],
      "router": {
        "adviser": "laya-mlx",
        "instructions": "Choose the team named by the principal's classification.",
        "routes": [
          { "id": "billing", "component": "billing", "description": "Invoices, payments, and refunds" },
          { "id": "technical", "component": "technical", "description": "Bugs, access problems, and outages" },
          { "id": "sales", "component": "sales", "description": "Plans, pricing, and new purchases" }
        ]
      }
    },
    { "id": "billing", "role": "internal", "catalog": "billing", "triggers": [{ "type": "manual" }] },
    { "id": "technical", "role": "internal", "catalog": "technical", "triggers": [{ "type": "manual" }] },
    { "id": "sales", "role": "internal", "catalog": "sales", "triggers": [{ "type": "manual" }] }
  ]
}
```

Route IDs and target component IDs are distinct. The adviser returns a route
ID. The network validator checks that every target exists and is enabled. A
router currently selects a leaf catalog Alter or a host capability component;
router-to-router and graph targets are deferred. A capability component may
set `input` to `text` (the default) or `json`. Approval-free capabilities run
through the host's function executor; approval-gated capabilities require a
host approval session. The network definition cannot supply executable code.

The router uses `laya-mlx` when `adviser` is omitted. Configure its local
checkpoint and Python environment in `.alters/config.json`:

```json
{
  "decision_advisers": {
    "laya-mlx": {
      "python": "/absolute/path/to/python",
      "model_dir": "/absolute/path/to/downloaded/laya-mlx",
      "timeout_ms": 30000
    }
  }
}
```

`LAYA_MLX_PYTHON` and `LAYA_MLX_MODEL_DIR` can supply those paths when the
project does not set them. The local checkpoint is a choice model with a shared
512-token context, so the adapter rejects oversized decision inputs. A host can
pass another adviser implementation under the configured ID.

## Running a route

```js
import { runNetworkRoute } from "@mind/core";

const run = await runNetworkRoute(projectRoot, {
  routerId: "router",
  routingSignal: "billing",
  payload: originalRequest,
  capabilityRegistry,
});
```

The principal spawns only the router through this call. The router is a recorded
Alter at depth 0 and its selected child is recorded at depth 1. The returned
`decision` and the router home's `decision.json` include the network revision,
candidate IDs, selected route, child run, and outcome. They omit the payload.
The router suppresses catalog prompt prefixes and suffixes for the selected
worker so its prompt remains exactly the principal's payload.
The CLI can run the same saved network with `mind network run router --signal
"billing" --payload "$request"`. For a network with approval-free function or
capability nodes, pass `--registry-module /absolute/path/to/trusted-host.mjs`;
the module must export `createRegistry()` and live outside the project root.
This binds host operations without allowing the network definition to load
executable code. Approval-gated capabilities require an in-process host that
provides an approval session. The CLI accepts `--project <dir>` when run
outside the project.
Pass `--verbose` to print the declared network tree to stderr after the run.
The tree marks spawned components with `*`, unspawned components with `.`, and
labels the selected route. The JSON result remains on stdout.

An invalid or unavailable adviser choice fails without spawning a child. Set
`fallback_route` to one of the declared route IDs to opt into a deterministic
fallback. A missing local model is treated as adviser failure. The child still
passes normal inherited authority, nesting depth, and tree-budget checks.
