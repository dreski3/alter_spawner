---
description: Use to spawn single-use sandboxed subagents called Alters. Spawn an Alter when you need a throwaway agent confined to its own folder for an isolated sub-task, when you want to prefilter/refine a prompt via a grandchild before running the real task, or to delegate work that must not touch the main workspace. Invoke with `node .alters/alter.mjs spawn ...`.
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
node .alters/alter.mjs spawn \
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
| `--nestable` | allow this Alter to spawn its own children (scoped shell + kit copy) |
| `--timeout <ms>` | per-run timeout (default `180000`) |
| `--rm` | delete the home after the run (default: keep) |
| `--verbose` | also print run stats to stdout |

## Default sandbox (locked to its home)
- `read`/`glob`/`grep`/`edit`/`write`: allowed **inside the home only**.
- `bash`, `webfetch`, `websearch`, `task`, `todowrite`, `question`: **denied**.
- `external_directory`: **denied** (cannot reach outside the home).
- Open holes with `--allow` (read) and/or `--allow-write` (read+write).
- `--nestable` adds a shell scoped to **only** `node .../alter.mjs ...`.

## Nesting & the prefilter pattern
An Alter cannot spawn children unless you pass `--nestable`. A nestable Alter
gets a scoped shell and its own copy of the kit, so it can spawn grandchildren.

**Prefilter (parent-driven, simpler):** you spawn a `prefilter` Alter, collect
its cleaned text from stdout, then spawn the worker Alter with that text as the
prompt. No `--nestable` needed.

**Prefilter (child-driven):** spawn the worker with `--nestable`; instruct it to
first spawn a grandchild `--name prefilter`, hand it the raw input, then continue
with the grandchild's cleaned output.

Max nesting depth is configured in `.alters/config.json` (`max_depth`, default 5).

## Other commands
```bash
node .alters/alter.mjs create  ...                 # scaffold a home without running it
node .alters/alter.mjs run <home-or-id> "<prompt>" # run an existing home
node .alters/alter.mjs list                        # list homes + status
node .alters/alter.mjs tree                        # nesting tree
node .alters/alter.mjs show <id>                   # print a home's result.json
node .alters/alter.mjs rm <id>                     # delete a home
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
