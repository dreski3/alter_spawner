# mind

A monorepo that builds the `mind` CLI — a tool for scaffolding and running
**Alters**: single-use, sandboxed sub-agents that a coding-agent session can
spawn (recursively, from a reusable catalog) to delegate isolated sub-tasks.

`mind init` turns any directory into an Alter-enabled project: an `AGENTS.md`
for the interactive parent session, an `alter` skill it can load on demand,
and a `.alters/` catalog of predefined Alter types. From there, spawning is
one command: `mind spawn --catalog researcher "..."`.

## Status

Not published. There is no `npx mind` yet. The CLI packs as one small,
self-contained tarball whose deterministic `dist/` artifact includes the core,
so local consumers no longer need the old two-package `npm link` sequence.
See [TODO.md](TODO.md) for what's left before that's a reasonable thing to do.

## Packages

- **`packages/core`** (`@mind/core`) — the engine. Project-root discovery
  (walks up from `cwd` for `.alters/config.json`, like `git` finds `.git`),
  catalog resolution, Alter-home scaffolding, retry/fallback, and a
  harness-adapter interface (`src/harness/adapter.js`) with `opencode` as the
  only implementation today (`src/harness/opencode.js`). Library callers can
  use `parseSpawnArgs` plus `spawnAlter` directly and pass an `AbortSignal` to
  cancel the underlying harness process without shelling out to `mind`.
  `runAlterGraph` executes validated dependency graphs, runs ready branches in
  parallel, interpolates dependency results, and checkpoints a graph trace.
- **`packages/cli`** (`mind`) — the `mind` bin: `init`, `update`, `spawn`,
  `create`, `run`, `list`, `tree`, `show`, `rm`, `catalog`. Ships a default
  project profile under `profiles/default/`.

A project's own `.alters/` holds only *data* — `config.json` and `catalog/` —
never a copy of the engine. Nestable Alters get the same treatment: their
scoped bash permission targets the resolved, absolute path of the running
`mind` CLI entrypoint rather than a vendored copy of it.

## Quickstart (local, unpublished)

```bash
# from this repo
npm install
npm pack --workspace packages/cli
npm install -g ./mind-0.1.0.tgz

# anywhere else
mkdir myproject && cd myproject
mind init                        # or: mind init --source <profile-dir>
mind spawn --catalog researcher "what changed in opencode 2.0?"
```

If you'd rather not touch global npm state, call the script directly:
`node /path/to/D2/packages/cli/src/index.js <command>` — useful during
active development on `mind` itself, since edits are live immediately (no
relink needed either way; `npm link` is a symlink).

## Concepts

**Alter** — a single-use, sandboxed agent that runs to completion in its own
throwaway home directory and returns one final answer. Default sandbox: read/
write confined to its home, no bash, no web, no external directory access.
Grants (`--allow`, `--allow-write`, `--web`, `--bash-allow`) open specific
holes; `--nestable` lets it run `mind spawn` itself, scoped to nothing else.

**Catalog** — `.alters/catalog/<name>/manifest.json` defines a reusable,
named Alter type (model, description/instructions, grants, nestable, token
budget, fallback model). `mind spawn --catalog <name> "..."` spawns one; any
explicit flag overrides the catalog's value for that field.

A catalog entry can declare an `output_contract` to distinguish a valid result
from non-empty error or filler text. Supported contract types are `nonempty`,
`exact`, `prefix`, `regex`, and `json`. Contract failures are recorded in the
attempt trace and use the same retry and fallback policy as other failed runs.

```json
{
  "output_contract": {
    "type": "regex",
    "pattern": "^SECRET:[^\\r\\n]+$"
  }
}
```

A catalog entry may include `opencode_provider`, using the same provider map
accepted by OpenCode's `provider` config key. The map is written to the
isolated Alter home's `opencode.json`, and the catalog's `model` is passed to
`opencode run --model` explicitly. Keep credentials out of manifests; use
OpenCode placeholders such as `{env:MY_PROVIDER_API_KEY}`. A provider map can
also be supplied while saving a catalog entry with
`--opencode-provider-file <json>`.

```json
{
  "name": "local-reviewer",
  "description": "Reviews a proposed change.",
  "model": "local/reviewer",
  "opencode_provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "apiKey": "{env:LOCAL_LLM_API_KEY}"
      },
      "models": { "reviewer": {} }
    }
  }
}
```

**Graph runs** — library callers can define chains and branches with
`runAlterGraph`. A node consumes a direct dependency using
`{{result:node-id}}`; nodes whose dependencies are ready run concurrently.
The output node's text is returned as `result.output`, while the full durable
trace is saved under `.alters/graphs/<timestamp>_<graph-id>/result.json`.

```js
import { runAlterGraph } from "@mind/core";

const run = await runAlterGraph(root, {
  id: "review-pipeline",
  output: "merge",
  nodes: [
    { id: "draft", catalog: "writer", prompt: "Draft the answer." },
    { id: "facts", catalog: "researcher", depends_on: ["draft"], prompt: "Check {{result:draft}}" },
    { id: "risks", catalog: "reviewer", depends_on: ["draft"], prompt: "Review {{result:draft}}" },
    { id: "merge", catalog: "editor", depends_on: ["facts", "risks"], prompt: "Merge {{result:facts}} and {{result:risks}}" }
  ]
});
```

The regular test suite verifies provider routing offline. A credentialed
OpenCode matrix can be exercised end to end with:

```bash
MIND_LIVE_PROVIDER_TESTS=1 \
MIND_LIVE_PROVIDER_MATRIX='[{"model":"provider-a/model-a"},{"model":"provider-b/model-b"}]' \
node --test packages/core/test/integration/provider-routing.live.test.js
```

Each matrix entry may also contain an `opencode_provider` map for a custom
provider; built-in providers can rely on the user's existing OpenCode auth.

**Profile** — what `mind init` scaffolds at a project's root: `AGENTS.md`,
`opencode.jsonc`, `.opencode/skills/alter/SKILL.md`, `.alters/config.json`,
`.alters/catalog/*`. The default ships in `packages/cli/profiles/default/`;
`--source <path>` points at an alternative profile with the same shape,
producing a different "kind of mind." `mind update [--source <path>]`
re-applies profile-owned files (skipping ones you've hand-edited) and adds
any new catalog entries without touching existing ones.

**Run folders** — every Alter home lives at `.alters/runs/<timestamp>_<id>/`
(applies at every nesting level). Timestamps make it safe to reuse the same
`--name` across reruns; `mind show`/`rm`/`run <id>` resolve a plain logical
id to its most recent matching run, or accept the exact folder name for a
specific past one.

**Result** — an Alter's final assistant message *is* its result: printed to
stdout, saved to `<home>/result.md`, with stats in `<home>/result.json` (tokens,
steps, model, per-attempt history). A run that exits cleanly but returns no
final message is therefore a failure, not a success — recorded as
`ok:false, empty_output:true` and retried through the fallback tiers.

**`bash_allow`** — a catalog entry can grant a scoped bash rule for one
specific external command (e.g. `"python3 /abs/path/cipher.py **"`),
independent of `nestable`. Lets an Alter shell out to a deterministic script
instead of paying for an inference call, without opening bash generally.

## Known limitations

- Not published. No `mind --help`/`--version` yet.
- OpenCode runs in `--pure` mode by default to avoid loading external plugins.
  A custom provider can still require its configured AI SDK runtime package.
- Only one harness adapter exists (`opencode`); the interface is unexercised
  by a second implementation.
- Output validation is opt-in. Catalog entries without `output_contract` still
  treat any non-empty final message as semantically successful.
- A nestable Alter occasionally fails to correctly compose its own scoped
  `mind spawn` bash invocation (bad quoting, or assuming it's blocked without
  trying) — not a permissions bug, a model-reliability one. Mitigated (not
  eliminated): the Alter's own `AGENTS.md` now bakes in the exact resolved
  invocation instead of the bare `mind` form it can't actually run; see
  TODO.md #1.

See [TODO.md](TODO.md) for the fuller list and next steps.

## Examples

- [`examples/cipher-relay`](examples/cipher-relay/README.md) demonstrates a
  nestable relay selecting isolated AES decryptor and format-decoder Alters,
  with separate sessions, homes, tool permissions, and token accounting.
