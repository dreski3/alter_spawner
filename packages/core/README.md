# `@mind/core`

The embeddable runtime behind Alter Spawner. It provides isolated Alter execution,
dependency graphs, oscillation scheduling, capability approvals, tree budgets, and
persistent-memory workflows.

```js
import { createSpawnOptions, runAlterGraph, spawnAlter } from "@mind/core";

const alter = await spawnAlter(
  projectRoot,
  createSpawnOptions({ catalog: "researcher", prompt: "Investigate this change." }),
);

const graph = await runAlterGraph(projectRoot, {
  id: "review",
  output: "merge",
  nodes: [
    { id: "research", catalog: "researcher", prompt: "Collect the facts." },
    { id: "merge", catalog: "editor", depends_on: ["research"], prompt: "Summarize {{result:research}}" },
  ],
});
```

Node.js 22.13 or newer is required. The package is ESM-only. Projects must first
contain a `.alters/config.json`; use the companion `mind` CLI's `mind init`
command or call `initMind(projectRoot)` from this package. The default profile is
included; pass `profileDir` to initialize from a host-specific profile.

SQLite memory automatically uses FTS5 when the active Node build provides it and
falls back to scope-indexed lexical scanning otherwise. Set `searchBackend` to
`"fts5"` to require the extension or `"scan"` to force the portable path.

See the repository README and `docs/embedding.md` for the host integration and
capability-approval contracts.
