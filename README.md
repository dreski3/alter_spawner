# mind

A monorepo that builds the `mind` CLI — a tool for scaffolding and running
**Alters**: single-use, sandboxed sub-agents that a coding-agent session can
spawn (recursively, from a reusable catalog) to delegate isolated sub-tasks.

`mind init` turns any directory into an Alter-enabled project: an `AGENTS.md`
for the interactive parent session, an `alter` skill it can load on demand,
and a `.alters/` catalog of predefined Alter types. From there, spawning is
one command: `mind spawn --catalog researcher "..."`.

## Status

Not published. There is no `npx mind` yet — everything here is exercised via
`npm link` or by invoking `packages/cli/src/index.js` with `node` directly.
See [TODO.md](TODO.md) for what's left before that's a reasonable thing to do.

## Packages

- **`packages/core`** (`@mind/core`) — the engine. Project-root discovery
  (walks up from `cwd` for `.alters/config.json`, like `git` finds `.git`),
  catalog resolution, Alter-home scaffolding, retry/fallback, and a
  harness-adapter interface (`src/harness/adapter.js`) with `opencode` as the
  only implementation today (`src/harness/opencode.js`).
- **`packages/cli`** (`mind`) — the `mind` bin: `init`, `update`, `spawn`,
  `create`, `run`, `list`, `tree`, `show`, `rm`, `catalog`. Ships a default
  project profile under `profiles/default/`.

A project's own `.alters/` holds only *data* — `config.json` and `catalog/` —
never a copy of the engine. Nestable Alters get the same treatment: their
scoped bash permission targets the resolved, absolute path of the running
`mind` CLI entrypoint rather than a vendored copy of it.

## Quickstart (local, unpublished)

```bash
# one-time, from this repo
npm install
cd packages/core && npm link
cd ../cli && npm link @mind/core && npm link   # registers a global `mind` bin

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

**`bash_allow`** — a catalog entry can grant a scoped bash rule for one
specific external command (e.g. `"python3 /abs/path/cipher.py **"`),
independent of `nestable`. Lets an Alter shell out to a deterministic script
instead of paying for an inference call, without opening bash generally.

## Known limitations

- Not published; `@mind/core` only resolves via workspace/`npm link`, not a
  registry. No `mind --help`/`--version`, no bundling step.
- `opencode run --dir <home>` regenerates its own `node_modules` inside every
  Alter home regardless of what `mind` ships in the template — a real
  per-run disk cost this CLI doesn't control.
- Only one harness adapter exists (`opencode`); the interface is unexercised
  by a second implementation.
- A model can silently return `ok:true` with empty output (observed with
  `zai-coding-plan/glm-4.5-air`) — `mind` doesn't currently flag this.
- A nestable Alter occasionally fails to correctly compose its own scoped
  `mind spawn` bash invocation (bad quoting, or assuming it's blocked without
  trying) — not a permissions bug, a model-reliability one.

See [TODO.md](TODO.md) for the fuller list and next steps.
