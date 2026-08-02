# Adaptive decoder

This experiment starts with one `adaptive-router` catalog entry and deliberately
omits the decoder. During its own inference session, the router must create a
private `caesar-decoder` catalog definition, spawn it, and return its result.
The current fixture is an assisted baseline: it supplies the exact two `mind`
command forms so the test isolates runtime catalog mutation from command
discovery and planning quality.

```bash
workdir=$(mktemp -d)
mkdir -p "$workdir/.alters"
node examples/adaptive-decoder/setup.mjs "$workdir"
node examples/adaptive-decoder/run-demo.mjs "$workdir"
```

Set `MIND_DEMO_MODEL` to select another OpenCode model. The final audit reports
whether the definition appeared inside the principal Alter's copied catalog,
how many children were spawned, and the principal's token/step cost.

## Initial observations

With `opencode/deepseek-v4-flash-free`, the assisted live baseline completed in
39.3 seconds using 31,141 combined tokens: 17,118 in the three-step principal
and 14,023 in the four-step decoder. These values are diagnostic, not budgets;
provider caches and model behavior make them variable.

A preliminary loosely instructed run failed before creating the definition. It
loaded an unrelated OpenCode customization skill and exceeded a 30,000-token
cap at 34,797 observed tokens. This suggests runtime mutation is supported, but
autonomously discovering the correct adaptation procedure needs a stronger
catalog-management affordance or a dedicated meta-alter.
