---
description: Use to spawn single-use sandboxed subagents called Alters, and to read or write persistent memory. Spawn an Alter when you need a throwaway agent confined to its own folder for an isolated sub-task, when you want to prefilter/refine a prompt via a grandchild before running the real task, or to delegate work that must not touch the main workspace. Also use when something should be remembered across conversations, or when an earlier conversation may already hold what you need. Invoke with `mind spawn ...` / `mind memory ...`.
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
| `--allow-catalog <name>` (repeat) | with `--nestable`, the only catalog entries the child may spawn |
| `--allow-no-catalogs` | with `--nestable`, the child gets a scoped shell but no catalog entries |
| `--max-tokens <n>` | kill the run if its token usage crosses this budget |
| `--fallback-model <provider/model>` | model to escalate to after same-model retries fail |
| `--prompt-prefix <text>` / `--prompt-suffix <text>` | text wrapped around the prompt |
| `--bash-allow <pattern>` | allow one exact command pattern in the Alter's shell |
| `--bash-only` | deny non-shell tools, useful for deterministic tool wrappers |
| `--text-only` | no tools at all: a text-in/text-out leaf, and the cheapest Alter to run |
| `--executor <name>` | which harness adapter runs it: `opencode` (default) or `llm` — see below. The model-free executors have to be bound by a host process, so do not reach for them here |
| `--output-exact <text>` / `--output-prefix <text>` | require a matching final result |
| `--output-regex <pattern>` | require the final result to match a regular expression |
| `--output-json` | require the final result to parse as JSON |

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
mind catalog save decoder --bash-only --bash-allow "node /abs/decode.mjs **" --output-prefix "SECRET:"
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

## Choosing an executor
`--executor opencode` (the default) gives the child a real coding-agent session: a
home directory, file tools, optionally a shell. Use it whenever the child has to
*do* something — read, write, search, run a command, spawn its own children.

`--executor llm` makes a single model call instead: your `--description` becomes
its system prompt, your prompt becomes the user message, and its reply is the
result. No home, no tools, no session. Measured against the same endpoint it
returns in ~2ms of local overhead versus ~2.4s for a session, and sends about a
fifth of the input tokens.

Reach for `llm` for text-in/text-out work — rewriting, compressing, extracting,
classifying, translating, normalizing. Reach for `opencode` for anything else.
A child that needs `--allow`, `--web`, `--bash-allow` or `--nestable` is not an
`llm` node; those flags have nothing to act on there.

## Tree budgets
`--max-tokens` bounds one Alter. A whole *tree* — you, your children, and
everything below them — is bounded separately by `.alters/config.json`:

- `max_tree_nodes` — total Alters the tree may spawn (default 64).
- `max_tree_tokens` — total tokens the tree may spend (off by default).
- `max_concurrent_alters` — how many run at once (default 4).

These are shared across every branch and every process, so spending is counted
once per tree rather than once per branch. Two consequences for you:

- A spawn can be **refused** with `tree node budget exhausted` (exit 1). That is
  a ceiling, not a transient error — **do not retry it**. Finish the task with
  what you already have, or answer directly, and say in your result that the
  tree budget ran out.
- A spawn can **block** while the tree is at `max_concurrent_alters`. That is
  normal backpressure; it will proceed on its own. Waiting on a child does not
  count against the cap, so a deep chain never starves itself.

Prefer a few well-scoped children over many speculative ones: the budget is the
whole tree's, and spending it on the shallow levels leaves nothing underneath.

## Failure fallback
On failure (non-zero exit, timeout, budget overrun, or an empty result), a spawn
retries according to `.alters/config.json`'s `retry` block (default: 1 retry on
the same model, then 1 retry on a fallback model — `--fallback-model`, else a
catalog entry's `fallback_model`, else the parent's own model for ad-hoc
spawns). A budget overrun does **not** retry (the same cap would just fail
again). The full attempt history — model used, outcome, tokens — is recorded in
`result.json.attempts`.

An **empty result** counts as a failure: an Alter that exits cleanly but returns
no final message has delivered nothing, since that message is the entire result
its parent receives. It is recorded as `ok:false, empty_output:true` (distinct
from a budget overrun) and, unlike an overrun, it *does* advance through the
retry tiers — returning nothing tends to be model-specific, so a same-model
retry and then a fallback model are both worth spending.

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

By default that `catalog/` is a full copy of yours, so a nestable child can
spawn anything you can. Narrow it with `--allow-catalog <name>` (repeatable) or
a catalog manifest's `allowed_catalogs`, and only those entries are copied into
the child's home — every other name simply fails to resolve. `--allow-no-catalogs`
(or `"allowed_catalogs": []`) leaves the child with a scoped shell and no
catalog at all. Narrowing is transitive: each level copies from its own already
filtered catalog, so a grandchild's reachable set can only shrink. Keep the set
small — it is both the permission boundary and the search space the child reads
before choosing whom to delegate to.

```bash
mind spawn --catalog adaptive-router --allow-catalog researcher "..."
```

**If you are yourself a nestable Alter reading this to spawn a child:** the
bare `mind` command is **not** on your PATH — your sandboxed shell only allows
one literal command form, `node <mindBinPath> ...`. Your own `AGENTS.md` (the
`## Spawning child Alters` section) already has this filled in with your exact
resolved path and a copy-pasteable example — use that literal command, not
`mind spawn ...` from the flag reference above. Pass each flag/value as its own
shell word; do not wrap the whole invocation in one quoted string, or the CLI
will see a single unparseable argument instead of the `spawn` command.

**Prefilter (parent-driven, simpler):** you spawn a `prefilter` Alter, collect
its cleaned text from stdout, then spawn the worker Alter with that text as the
prompt. No `--nestable` needed.

**Prefilter (child-driven):** spawn the worker with `--nestable`; instruct it to
first spawn a grandchild `--name prefilter`, hand it the raw input, then continue
with the grandchild's cleaned output.

Max nesting depth is configured in `.alters/config.json` (`max_depth`, default 5).

## Persistent memory (`mind memory`)
Your session carries this conversation. **Persistent memory is the layer above
it** — the small set of facts, preferences and decisions that should still be
true in a conversation that has not happened yet. It is a tool you reach for
deliberately, not something applied to every turn.

```bash
mind memory search "how the bridge is started" --limit 5
mind memory search "deployment preferences" --kind preference --kind decision
mind memory put "The relay dev server runs on port 3003." --kind fact --tag relay
mind memory put "Prefers no code comments unless asked." --kind preference
```
| flag | meaning |
|---|---|
| `--limit <n>` | most records to return (1–100, default 10) |
| `--kind <k>` (repeat) | restrict/label: `fact`, `preference`, `decision`, `summary` |
| `--tag <t>` (repeat, `put` only) | tags stored with the record |
| `--confidence <0-1>` | how sure you are (default 1) |
| `--expires-at <iso>` | drop the record after this instant |
| `--json` | the raw result instead of the readable summary |

**You are asking, not doing.** You do not hold the memory store and cannot reach
it. Each command posts your request to your host, which shows the user an
approval card and — only if they approve — performs the operation itself. Three
outcomes, all of which you must handle:

- **Approved** — the records, or the stored result, print on stdout.
- **Denied** — a line beginning `denied:` prints on stdout and the command
  *succeeds* (exit 0). The user was asked and said no. That is a real answer:
  carry on without the memory and **do not run the command again**, because a
  retry only puts the same card in front of the same person.
- **Unavailable** — a non-zero exit saying persistent memory is unavailable
  here. No host is listening, so nothing was read or written and there is no
  other way in. Continue without it.

Scope is not yours to pick. Which project and conversation you can see, and the
provenance recorded on anything you store, are decided by the host and stamped
onto the request it runs; there are no flags for them.

Write sparingly. Good records are short, self-contained, and durable — a
preference, a decision and its reason, a stable fact about the project. Anything
only true of the current turn belongs in your session, not here. Search before
writing: the store deduplicates identical content, but not a paraphrase of
something it already knows.

If `mind` is not on your PATH, `node "$MIND_BIN"` runs the same CLI. Do not try
to install it from a package registry — nothing published there is this CLI.

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
