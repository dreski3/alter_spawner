# TODO

Context for picking this back up in a new session: `mind` (this monorepo) is
functional and has been exercised end-to-end via `npm link` in several test
projects under `../projects/` (`cipher-relay`, `cipher-relay-optimizing`).
The items below are what's known-missing or known-flaky, roughly in priority
order. See [README.md](README.md) for the architecture.

## 1. Nested-spawn reliability (highest priority — found live)

Observed twice in `projects/cipher-relay-optimizing`, running `courier`
(nestable, `zai-coding-plan/glm-5-turbo`) after it had self-rewritten its own
catalog manifest to add a `bash_allow` script rule alongside its existing
`nestable` mind-spawn rule:

- **Run 2**: the model asserted `mind spawn` was "blocked by permissions"
  and never attempted it — no child run folder was ever created. The
  frontmatter was verified correct (both bash rules present); the model just
  didn't try.
- **Run 3**: it did attempt the call, but got back `mind`'s bare usage text
  — meaning the bash command it composed didn't parse as `spawn ...` at all
  (almost certainly a quoting mistake, e.g. wrapping the whole invocation in
  one quoted string so `process.argv[2]` wasn't literally `"spawn"`).

Neither is a sandbox/permission bug — the engine allowed exactly what it
should. It's the model failing to reliably compose a shell command inside a
locked-down bash rule.

Proposed hardening:
- When `mind`'s `index.js` gets an unrecognized `cmd`, currently it just
  prints usage and exits (see `packages/cli/src/index.js`'s `main()`). Make
  this louder/more actionable: echo back what was actually parsed (e.g.
  `mind: unrecognized command "..." (argv: [...])`) so a model reading bash
  stderr has a concrete reason to retry differently, instead of a generic
  usage dump indistinguishable from "you ran `mind` with no args."
- Consider a `bash_allow`/nestable pattern that's more forgiving of quoting
  variance — or document in the `alter` skill (`packages/core/templates/
  alter-home/.opencode/skills/alter/SKILL.md`) an exact, copy-pasteable
  invocation example for the nested-spawn case, since the model is currently
  only told the flag reference, not a worked example inside its own sandbox.
- Add an integration test that spawns a nestable Alter and has it spawn a
  child for real, asserting the child's run folder exists and its result is
  `ok:true` — this is the one path most exercised by the actual vision
  (alters spawning alters) and currently has zero automated coverage.

## 2. Silent-empty-output detection

`zai-coding-plan/glm-4.5-air` (and possibly other models) can return exit
code 0, no kill, no budget overrun — `ok:true` — with zero `text` and near-
zero output tokens. `result.md` ends up as `(no output)`. Confirmed via raw
`opencode run --format json` output: only `step_start`/`step_finish` events,
no `text` event at all, `output` token count of ~1.

Proposed hardening (`packages/core/src/harness/opencode.js` and/or
`packages/core/src/retry.js`):
- In `runAgent`'s `finish()`, if `exitCode === 0 && !killed` but
  `acc.text.trim() === ""`, consider that a distinct outcome — e.g. set
  `res.empty_output = true` — and thread it into `result.json`.
- Decide whether `buildAttemptPlan`/`runWithRetries` should treat
  `empty_output` like a failure worth retrying (same-model retry, then
  fallback), the way `budget_exceeded` is handled today, instead of silently
  recording success with nothing to show for it.

## 3. Test coverage

Nothing is automated yet — correctness has only been verified by manual
`npm link` + real spawns against live models (expensive and non-repeatable).
Needs:
- Unit tests for `packages/core/src` — `scaffold`, `catalog` (validate/
  apply/save), `retry` (`buildAttemptPlan`), `frontmatter` (`buildFrontmatter`
  output for nestable / `bash_allow` / grants combinations), `homes`
  (`resolveHome`/`removeHome`'s "most recent wins" logic).
- An integration test that fakes the harness adapter (register a test
  double via `registerHarness`) so spawn/retry/catalog flows can be tested
  without hitting a real model or `opencode` binary.
- A real pack-and-install smoke test (`npm pack` + install into a temp dir)
  to replace the manual `npm link` verification done so far.

## 4. CLI polish

- `mind --help` / `mind --version` (currently only bare `mind` with no args
  prints usage; there's no version flag at all).
- Top-level usage text in `packages/cli/src/index.js` doesn't document
  `--bash-allow` (added this session) — update it and the `alter` skill doc.
- `packages/cli/profiles/default/` ships only the `researcher` catalog entry
  — consider whether the default profile should include a plain
  general-purpose worker entry too, since `researcher` is web-specific.

## 5. Publishing path

- Decide a real package name/scope (`mind` is almost certainly taken on the
  public registry).
- `packages/cli/package.json` lists `@mind/core` as a normal dependency
  (`^0.1.0`); this only resolves via workspace linking today. Add a build
  step that bundles `@mind/core` into the published `mind` tarball, or
  publish both packages together under one scope.
- No LICENSE file yet anywhere in this repo.

## 6. Vision-level follow-ups (lower priority, exploratory)

- A second harness adapter (even a minimal/stub one) to prove
  `packages/core/src/harness/adapter.js`'s interface actually generalizes —
  it's only ever had one implementation.
- More default catalog richness / more named profiles (only `default` exists
  today, with one catalog entry).
- Investigate whether `opencode run --dir <home>` can be pointed at a shared
  `node_modules` cache instead of regenerating one per Alter home (confirmed
  ~60MB+ per home, entirely from opencode's own behavior, not from anything
  `mind` scaffolds — see README's Known Limitations).
- The self-modifying-catalog pattern (an Alter rewriting its own or another
  catalog entry, as tested in `projects/cipher-relay-optimizing`) worked
  mechanically. Worth a follow-up test where the rewritten entry is used
  across a few more reruns to see if it stays correct, and whether an Alter
  can safely be trusted to edit *other* Alters' catalog entries (not just
  its own) without supervision.
