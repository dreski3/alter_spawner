# Laya network router example

This saved network has a principal, a `laya-mlx` router Alter, three worker
Alters (`billing`, `technical`, and `sales`), and an optional deterministic
uppercase tool node. The principal may spawn only the router. The router chooses
one declared route from the principal's classification signal, then forwards
the separate request payload unchanged to the selected child.

Set the paths to a Python environment with `laya_mlx` installed and to the
downloaded checkpoint, then create a temporary project and run its saved
network with `mind`:

```sh
export LAYA_MLX_PYTHON=/Users/andressarria/Development/NautDesktop/laya-mlx/.venv/bin/python
export LAYA_MLX_MODEL_DIR=/Users/andressarria/Development/NautDesktop/laya-mlx/models/laya-mlx
node examples/laya-router/setup.mjs /tmp/my-laya-router
./node_modules/.bin/mind network run router \
  --project /tmp/my-laya-router \
  --registry-module examples/laya-router/host.mjs \
  --verbose \
  --signal "The customer was billed twice and requests a refund." \
  --payload "Please refund the duplicate charge of 25 euros."
```

The setup copies the catalog and applies [network.json](network.json) as
revision 1. The `mind network run` command prints the selected route, result,
and run folders. The workers use deterministic host functions, so the decision
is the only model call. `host.mjs` is a trusted host binding outside the
temporary project; it supplies the example's worker and uppercase functions.
`--verbose` prints an ASCII tree of the declared nodes and edges to stderr.
An asterisk marks a spawned Alter or tool node; a dot marks one not spawned.
The selected route is labeled even if its child fails to spawn. JSON stays on
stdout.

Try another classification from the same project:

```sh
./node_modules/.bin/mind network run router \
  --project /tmp/my-laya-router \
  --registry-module examples/laya-router/host.mjs \
  --signal "The app is down and users cannot sign in." \
  --payload "Investigate incident 431."
```

The network can also route to `uppercase-tool`, which is a direct host
capability node rather than a catalog worker. The router and its child use two
tree nodes. Adviser failures do not select another destination unless the
network explicitly sets `fallback_route`.
