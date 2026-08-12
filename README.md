# Alter Spawner (`mind`)

Alter Spawner is a framework for building user-facing AI agents whose work is
performed by isolated processing instances called **Alters**. One execution of
an Alter is a **spike**. Recurring, phased groups of spikes are
**oscillations**. Together, graphs, oscillations, memory, capability policies,
and reward or maintenance tasks form the agent's metabolic layer: background
work can consolidate memory, revisit unfinished goals, inspect resource use,
and improve future execution without making every internal process part of the
agent's conversational context.

The monorepo currently builds the `mind` CLI and the `@mind/core` embedding
library. The names are distribution names; Alter Spawner is the framework.

`mind init` turns any directory into an Alter-enabled project: an `AGENTS.md`
for the interactive parent session, an `alter` skill it can load on demand,
and a `.alters/` catalog of predefined Alter types. From there, spawning is
one command: `mind spawn --catalog researcher "..."`.

## Status

Pre-release (`0.1.0`) and not yet published to a public registry. Both packages
produce installable tarballs. The CLI is self-contained; the core package is an
ESM library with declarations and its initialization profile included. Consumer
installation is exercised in the integration suite. See [ROADMAP.md](ROADMAP.md)
for the remaining publication decisions.

Start with [the architecture](docs/architecture.md) for the framework model,
[the embedding guide](docs/embedding.md) for host integration, and
[CONTRIBUTING.md](CONTRIBUTING.md) for the verification and release workflow.

## Packages

- **`packages/core`** (`@mind/core`) — the engine. Project-root discovery
  (walks up from `cwd` for `.alters/config.json`, like `git` finds `.git`),
  catalog resolution, Alter-home scaffolding, retry/fallback, and a
  harness-adapter interface (`src/harness/adapter.js`) with a session-based
  `opencode` adapter and a direct, tool-free `llm` adapter. Library callers can
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
`.alters/memory/store.json`; `{ backend: "sqlite" }` uses WAL and, when available,
FTS5 under
`.alters/memory/store.sqlite`. Both enforce the same scopes, normalization,
optimistic versions, active-record deduplication, atomic mutation batches,
storage accounting, and store/namespace quotas. SQLite performs indexed scope
reads and keeps its FTS rows in the same transactions as record changes. Node
builds without FTS5 fall back to the same lexical scoring over scope-indexed
records; set `searchBackend: "fts5"` to require FTS5 or `searchBackend: "scan"`
to select the portable path explicitly.
`mind memory stats` requests the visible storage report through the host.

`physicalBytes` counts live stored data in both backends, so removing records
lowers it and quota decisions stay meaningful. SQLite additionally reports
`fileBytes`, the raw on-disk total, and `reclaimableBytes`, their difference:
neither a vacuum-free database nor a write-ahead log returns space on its own.
`store.compact()` reclaims it by merging the FTS index, which is where deleted
search rows leave tombstones, then vacuuming and truncating the log; it returns
the post-compaction report plus `reclaimedBytes`. It is part of the store
contract on both backends, a no-op on JSON, where each write already rewrites the
whole document. The log is separately capped by
`journalSizeLimitBytes` (4 MiB by default) so it cannot grow without bound
between compactions, and a JSON migration compacts before handing the store
over. A maintenance Alter reading `reclaimableBytes` can therefore tell slack
apart from real consumption instead of chasing a number its own cleanup cannot
move.

`mind init`
and `mind update` add `.alters/memory/` to `.gitignore` because memory may
contain private project context.

`createMemoryCapabilityRegistry` exposes search/read and exact write/update/
delete operations through the same approval contract. Mutations only allow
`allow-once` or `deny`, so a one-off write is approved by the person who asked
for it and nothing else. That is wrong for a host that curates and maintains
memory on a cycle, where the same card returns every pass and no answer ends it,
so `grantable` widens named mutations — or all of them, with `true` — to accept
`allow-run` and `always-catalog` as well. Consent is still asked for; it can now
be given durably. The default profile includes `memory-recaller` and
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

A committed plan containing deletes or updates leaves reclaimable slack behind,
so the cycle then requests `memory.records.compact` as a second, separate
approval; pass `compact: false` to skip it. Pure writes cannot free space and
never raise the card. The capability is bound to the `memory-manager` catalog,
but the planning Alter never invokes it: its manifest grants no shell access, so
the cycle asks on the catalog's behalf only after the plan has committed. That
matters because compaction reaches the entire store rather than the scope the
planner was shown, which is why the request names `affects: "entire-store"` in
its preview. It changes no record, so it may be granted for a run but never for
all future runs, and declining it leaves the committed plan and its audit record
untouched with `storage: null`.

## Known limitations

- Not published; the final registry names and repository metadata are still a
  release decision.
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
  invocation instead of the bare `mind` form it can't actually run.

See [ROADMAP.md](ROADMAP.md) for the fuller list and next steps.

## Examples

- [`examples/cipher-relay`](examples/cipher-relay/README.md) demonstrates a
  nestable relay selecting isolated AES decryptor and format-decoder Alters,
  with separate sessions, homes, tool permissions, and token accounting.
