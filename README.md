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
  Capability registries and approval sessions provide transport-neutral host
  approvals before a registered executable can run.
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

The adaptive-decoder limit test demonstrates a nestable principal creating a
missing catalog definition during inference and immediately spawning it:

```bash
workdir=$(mktemp -d)
mkdir -p "$workdir/.alters"
node examples/adaptive-decoder/setup.mjs "$workdir"
node examples/adaptive-decoder/run-demo.mjs "$workdir"
```

Its audit includes the private definition, child trace, wall time, steps, and
combined parent/child token usage. Run the corresponding live test with
`npm run test:live:adaptive`.

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

**Host capability approvals** — library callers register fixed executable
vectors or schema-validated trusted handlers with `createCapabilityRegistry`,
bind capability IDs to catalogs, and create one
`createCapabilityApprovalSession` per run. The session emits transport-neutral
lifecycle events and pauses `execute` until a caller returns one of the
explicit decisions through `decide`. Structured inputs are cloned, frozen, and
bound to the request with a SHA-256 digest over the capability ID, executor
version, and canonical input. Approval input contains only an opaque request
ID and decision; it cannot replace the registered executor or mutation. Run
grants live in the session, while persistent catalog grants are supplied
through policy hooks.
An adapter renders `event.approval`, then passes only its ID and an explicit
decision back to core:

```js
const execution = approvals.execute("lan.neighbors.read", {
  reason: "LAN Inspector needs the current neighbor table."
});

await approvals.decide(approvalId, "allow-once");
const result = await execution;
```

**Persistent memory** — `createProjectMemoryStore` provides interchangeable
JSON and SQLite backends. JSON remains the compatibility default under
`.alters/memory/store.json`; `{ backend: "sqlite" }` uses WAL and FTS5 under
`.alters/memory/store.sqlite`. Both enforce the same scopes, normalization,
optimistic versions, active-record deduplication, atomic mutation batches,
storage accounting, and store/namespace quotas. SQLite performs indexed scope
reads and keeps its FTS rows in the same transactions as record changes.
`mind memory stats` requests the visible storage report through the host.
`mind init`
and `mind update` add `.alters/memory/` to `.gitignore` because memory may
contain private project context.

`createMemoryCapabilityRegistry` exposes search/read and exact write/update/
delete operations through the same approval contract. Mutations only allow
`allow-once` or `deny`. The default profile includes `memory-recaller` and
`memory-curator`: one Alter creates a narrow search plan before retrieval, and
the other proposes durable records after a run. Neither Alter receives direct
database access.

```js
const store = createProjectMemoryStore(root, { projectId: "naut" });
const registry = createMemoryCapabilityRegistry({ store });
const approvals = createCapabilityApprovalSession({
  registry,
  catalogId: "memory-curator",
  onEvent
});

const curated = await runMemoryCurator(root, {
  content: completedRun.text,
  scope: { project: "naut" },
  source: { runId: completedRun.id },
  approvals
});
```

SQLite uses the built-in `node:sqlite` module and therefore requires Node
22.13 or newer. Migration copies the schema-v1 JSON records while preserving
IDs, scopes, versions, timestamps, provenance, and metadata. It never modifies
or removes the JSON source and is idempotent when rerun:

```bash
mind memory migrate --to sqlite
```

```js
await migrateFileMemoryStoreToSqlite({
  sourceFile: memoryFilePath(root),
  destinationFile: sqliteMemoryFilePath(root),
  projectId: "naut",
});

const store = createProjectMemoryStore(root, {
  projectId: "naut",
  backend: "sqlite",
});
```

Graph nodes can declare automatic recall and curation hooks. Every recall is
resolved before the graph starts, producing a stable memory view for that
cycle. Successful node outputs are queued for curation; all curators run in
parallel only after the computational graph finishes, so their writes become
visible on the next graph cycle rather than at timing-dependent points in the
current one. Recall and curation failures are recorded in the graph trace and
do not discard otherwise successful graph work.

```js
await runAlterGraph(root, {
  id: "research-cycle",
  nodes: [
    {
      id: "researcher",
      prompt: "Investigate the current design.",
      memory: {
        recall: { namespace: "architecture", query: "prior architecture decisions" },
        curate: { namespace: "architecture" },
      },
    },
  ],
}, {
  memory: {
    scope: { project: "naut" },
    recallApprovals,
    curateApprovals,
  },
});
```

The graph result includes a unique `memory_cycle` ID, its `next-cycle`
consistency mode, aggregate recalled/curated record counts, and per-node hook
states, record IDs, namespaces, and errors.

Longer-running consolidation is an explicit maintenance graph rather than a
side effect of ordinary Alter execution. `buildMemoryMaintenanceGraph` creates
an approval-gated inspection node followed by a `memory-manager` planning
Alter. The bounded snapshot includes native storage and quota statistics plus
visible candidate records. `runMemoryMaintenanceGraph` validates the returned
operation array and requests one atomic `memory.records.maintain` execution.
An empty plan returns without requesting mutation approval, so the entire
cycle can be observational and every unrelated graph remains stateless.

```js
const maintenance = await runMemoryMaintenanceGraph(root, {
  scope: { project: "naut", namespace: "architecture" },
  approvals: mutationApprovalSession,
  harness: "opencode",
  graph: { limit: 100, includeExpired: true },
});

if (!maintenance.committed) {
  console.log("The manager chose to leave memory unchanged.");
}
```

The host must bind the graph's `capability` executor to the same memory
registry used for approvals. Maintenance writes and updates are exact and
version-aware. Deletes are rejected before approval by default; callers must
set `allowDeletes: true` to permit a planner to propose them. Each completed
cycle writes `maintenance.json` beside the graph's `result.json` for audit.

## Known limitations

- Not published. No `mind --help`/`--version` yet.
- OpenCode runs in `--pure` mode by default to avoid loading external plugins.
  A custom provider can still require its configured AI SDK runtime package.
- Only one harness adapter exists (`opencode`); the interface is unexercised
  by a second implementation.
- Persistent-memory retrieval is lexical. SQLite adds FTS indexing, but no
  embedding/vector or semantic-reranking adapter exists yet.
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
