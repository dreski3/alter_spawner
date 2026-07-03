---
description: Use to spawn single-use sandboxed subagents called Alters. Spawn an Alter when you need a throwaway agent confined to its own folder for an isolated sub-task, when you want to prefilter/refine a prompt via a grandchild before running the real task, or to delegate work that must not touch the main workspace. Invoke with `mind spawn ...`.
---

# Skill: alter — spawn single-use sandboxed Alters

An **Alter** is a single-use, sandboxed opencode agent that runs to completion in
its own home directory (`.alters/<id>/`). It has its own `AGENTS.md`, agent
definition, skills, and model. It can only touch its own home unless you grant
it external access. Spawns are **synchronous**: the call blocks until the Alter
finishes and returns its answer on stdout.

## When to spawn an Alter
- A self-contained sub-task you want isolated from the main workspace.
- **Prefiltering**: spawn a grandchild that cleans/refines a prompt, then feed
  its output to the real child task.
- Decomposing work into focused, sandboxed workers (spawn several).
- Running something exploratory where you want the blast radius confined.

## Spawn (the main command)
```bash
mind spawn \
  --name <short-role> \
  --description "<one-line persona>" \
  --prompt "<the task instruction>"
```
The Alter's final assistant message is printed to **stdout** (that is your
answer) and also saved to `<home>/result.md` (+ `result.json` with stats).

### Flags
| flag | meaning |
|---|---|
| `--name <id>` | short role id (folder name); default `alter_<epoch>_<n>` |
| `--description <text>` | persona/role, baked into the Alter's agent definition |
| `--prompt <text>` (or positional) | the task instruction the Alter runs |
| `--model <provider/model>` | override the inherited model |
| `--allow <abs-path>` (repeat) | grant external READ (read/glob/grep) to a file/dir |
| `--allow-write <abs-path>` (repeat) | grant external READ+WRITE to a file/dir |
| `--nestable` | allow this Alter to spawn its own children (scoped shell) |
| `--web` | allow `webfetch`/`websearch` (denied by default) |
| `--timeout <ms>` | per-run timeout (default `180000`) |
| `--rm` | delete the home after the run (default: keep) |
| `--verbose` | also print run stats to stdout |
| `--catalog <name>` | spawn a predefined harness from `.alters/catalog/<name>/manifest.json` |
| `--max-tokens <n>` | kill the run if its token usage crosses this budget |
| `--fallback-model <provider/model>` | model to escalate to after same-model retries fail |
| `--prompt-prefix <text>` / `--prompt-suffix <text>` | text wrapped around the prompt |

## Catalog: predefined harnesses
`.alters/catalog/<name>/manifest.json` defines a reusable, named harness (model,
description, token budget, fallback model, grants, optional `AGENTS.md` override
and extra skills). Spawn one with `--catalog <name>`; any flag you pass
explicitly overrides that catalog field, anything you omit is filled from the
catalog manifest (grant lists are override-not-merge: passing even one `--allow`
replaces the catalog's grants entirely).
```bash
mind catalog list                             # see available harnesses
mind catalog show researcher                  # print a harness's manifest.json
mind spawn --catalog researcher "what changed in opencode 2.0?"
mind catalog save my-harness --from <alter-id>   # promote a spawned alter
mind catalog save my-harness --description "..." --model ... --max-tokens 100000
```
Catalog resolution is local-folder-based today (`source.type: "local"` in each
manifest); the field is a reserved seam for a future non-local (e.g. MCP) source.

## Token budgets
`--max-tokens <n>` (or a catalog's `max_tokens`) kills the Alter's process as
soon as its running token total crosses the cap. **Caveat:** enforcement fires
as soon as usage becomes visible on stdout. Whether that is genuinely mid-run or
only once the harness has already finished and flushed everything at once
depends on the harness's own buffering, which this tool does not control. In
the worst case it is equivalent to "reject after the fact" — the run has
already spent its tokens, and the effect is limited to `result.json` recording
`ok:false, budget_exceeded:true` with no further retries proceeding.

## Failure fallback
On failure (non-zero exit, timeout, or budget overrun), a spawn retries
according to `.alters/config.json`'s `retry` block (default: 1 retry on the same
model, then 1 retry on a fallback model — `--fallback-model`, else a catalog
entry's `fallback_model`, else the parent's own model for ad-hoc spawns). A
budget overrun does **not** retry (the same cap would just fail again). The full
attempt history — model used, outcome, tokens — is recorded in
`result.json.attempts`.

## Default sandbox (locked to its home)
- `read`/`glob`/`grep`/`edit`/`write`: allowed **inside the home only**.
- `bash`, `webfetch`, `websearch`, `task`, `todowrite`, `question`: **denied**.
- `external_directory`: **denied** (cannot reach outside the home).
- Open holes with `--allow` (read), `--allow-write` (read+write), and/or `--web`
  (webfetch/websearch — needed for anything that must actually browse the live web).
- `--nestable` adds a shell scoped to **only** the resolved `mind` CLI entrypoint.

## Nesting & the prefilter pattern
An Alter cannot spawn children unless you pass `--nestable`. A nestable Alter
gets a scoped shell and its own `.alters/config.json` + `catalog/`, so it can
spawn grandchildren.

**Prefilter (parent-driven, simpler):** you spawn a `prefilter` Alter, collect
its cleaned text from stdout, then spawn the worker Alter with that text as the
prompt. No `--nestable` needed.

**Prefilter (child-driven):** spawn the worker with `--nestable`; instruct it to
first spawn a grandchild `--name prefilter`, hand it the raw input, then continue
with the grandchild's cleaned output.

Max nesting depth is configured in `.alters/config.json` (`max_depth`, default 5).

## Other commands
```bash
mind create ...                  # scaffold a home without running it
mind run <home-or-id> "<prompt>" # run an existing home
mind list                        # list homes + status
mind tree                        # nesting tree
mind show <id>                   # print a home's result.json
mind rm <id>                     # delete a home
mind catalog list|show|save      # manage predefined harnesses
```

## Model inheritance
Without `--model`, an Alter inherits its parent's model (root defaults to
`config.json` `default_model`). The effective model is written into each child's
kit config, so grandchildren inherit by default.

## Tips
- Keep prompts self-contained: the Alter does **not** share your context.
- The home persists after the run (unless `--rm`) — inspect `<home>/result.md`
  and any artifacts it wrote.
- Grant absolute paths with `--allow`/`--allow-write` (`~` is expanded).
- A non-nestable Alter is a pure leaf (no shell). Use `--nestable` only when the
  Alter itself must spawn children.
