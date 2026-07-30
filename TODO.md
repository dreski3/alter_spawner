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

Root cause found: a nestable Alter's `AGENTS.md`/skill doc told it to run bare
`mind spawn ...`, but `mind` is never on a spawned Alter's `PATH` — the only
bash pattern its permission rule actually allows is the literal
`node <resolved-mind-bin-path> ...`. That fully explains both observed
failures (Run 2: the bare command really would be denied, so "blocked by
permissions" wasn't wrong, just untried against the right command; Run 3:
composing the unfamiliar `node <path> spawn ...` form by hand is exactly where
a quoting mistake creeps in).

Status: **done**, this session —
- `mind`'s unrecognized-command path now echoes back the parsed argv
  (`packages/cli/src/index.js`) instead of a bare usage dump.
- `packages/core/src/frontmatter.js`'s `NESTING_BLOCK` now bakes in the exact
  resolved `node <path> spawn ...` invocation (not bare `mind`) plus an
  explicit warning against wrapping the whole call in one quoted string;
  `packages/core/templates/alter-home/.opencode/skills/alter/SKILL.md` now
  tells a nestable Alter to use that AGENTS.md example instead of the generic
  flag reference.
- Added `packages/core/test/integration/nested-spawn.test.js`, a real
  (non-mocked) end-to-end test: spawns a nestable Alter, has it spawn a real
  grandchild, asserts the grandchild's run folder + `result.json.ok === true`.
  Opt-in (`MIND_LIVE_TESTS=1 npm run test:live:nested-spawn`) since it hits a
  real model/opencode process — passed on first live run after the doc fix.

Still open: this only reduces the failure mode, it doesn't eliminate model
unreliability structurally. Worth revisiting if the live test starts flaking
again — e.g. a more forgiving `bash_allow` pattern (accepting minor quoting
variance) rather than requiring one exact literal command form.

## 2. Silent-empty-output detection

`zai-coding-plan/glm-4.5-air` (and possibly other models) can return exit
code 0, no kill, no budget overrun — `ok:true` — with zero `text` and near-
zero output tokens. `result.md` ends up as `(no output)`. Confirmed via raw
`opencode run --format json` output: only `step_start`/`step_finish` events,
no `text` event at all, `output` token count of ~1.

Status: **done**, this session.

Decided: an empty result is a **failure that retries**. The alter-home
`AGENTS.md` tells every Alter its final message "is all your parent will receive
from you", so a clean exit with nothing in it is a broken contract, not a
success — and unlike a budget overrun (deterministic under the same cap) it's
usually model-specific, so it's worth spending the same-model retry and then the
fallback model. No opt-out flag was added: no catalog entry today is meant to
return nothing, and a silent-success escape hatch would reintroduce exactly the
hole this closes.

- `packages/core/src/harness/opencode.js`: new pure, exported
  `classify({exitCode, killed, budgetExceeded, text})` — the whole outcome
  table in one place, testable without spawning `opencode`. It sets
  `empty_output` only for a *clean* exit with blank text (a killed or
  over-budget run keeps its own reason) and folds it into `ok`, exactly as
  `budget_exceeded` already was. `finish()` now spreads its result.
- `packages/core/src/retry.js`: no logic change needed — `empty_output` yields
  `ok:false, budget_exceeded:false`, so the existing loop already escalates
  through both tiers. Each attempt now records its own `empty_output`.
- `packages/core/src/homes.js`: `empty_output` is threaded into `result.json`.
- `packages/core/src/harness/adapter.js`: contract documents `empty_output` and
  notes that a new adapter reporting `false` still behaves correctly.
- `packages/cli/src/commands/{spawn,run}.js`: print a one-line stderr
  diagnostic naming the model and attempt count, so this case isn't a bare
  exit 1 with no output at all (which reads like a crash).
- Tests: `packages/core/test/unit/classify.test.js` (8 outcome-table cases) and
  `packages/core/test/integration/empty-output-retry.test.js` (fake harness via
  `registerHarness` — recovers-on-fallback, always-empty, and
  succeeds-first-try). Both offline; `npm test` runs them.

Still open: detection is text-presence only. An Alter that returns filler prose
while having done nothing useful is still scored `ok:true` — catching that needs
ground-truth verification outside the harness (the pattern D3's dispatcher uses:
re-run the tests, hash the target file).

## 3. Test coverage

Started (see #2). `npm test` now runs everything offline —
`node --test "packages/core/test/**/*.test.js"`, with the live nested-spawn test
skipping itself unless `MIND_LIVE_TESTS=1`. What exists: `classify`'s outcome
table (unit) and a fake-harness spawn/retry integration test that exercises
scaffold → attempt plan → `result.json` with no model and no `opencode` binary.
The `registerHarness` test-double pattern this item asked for is in
`test/integration/empty-output-retry.test.js` and generalizes to the rest.

Still needed:
- Unit tests for `scaffold`, `catalog` (validate/apply/save), `retry`
  (`buildAttemptPlan` tiers directly), `frontmatter` (`buildFrontmatter` output
  for nestable / `bash_allow` / grants combinations — the security-relevant
  one, currently only covered incidentally), `homes`
  (`resolveHome`/`removeHome`'s "most recent wins" logic).
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

## 6. Token budget counts cached reads (found live)

`--max-tokens` / `max_tokens` is enforced against `acc.tokens.total`, which includes
`cache_read`. For a multi-step Alter working over one large fixed context, cached
re-reads dominate that total and the cap fires on re-reading rather than on real
spend.

Observed in `../D4` (2026-07-30): an Alter was SIGKILLed at `total` 261,510 against
a 260,000 cap, of which `cache_read` was 176,640 — actual new work was
input 76,960 + output 5,194 + reasoning 2,716 ≈ 85k, a third of the cap. It died
mid-write, leaving a partially-written artifact that looked complete enough to be
misleading (`PROPOSAL.md` finished, but 10 of the 13 files it declared were absent).

Worth deciding what the cap is *for*. If it is a cost control, cached reads are the
cheapest tokens there are and arguably do not belong in it; if it is a
runaway-loop guard, `total` is defensible but the current value means very different
things for a one-shot task and a many-step one. Options: cap on
`input + output + reasoning` (excluding `cache_read`), expose both numbers and let a
catalog entry choose, or keep `total` and document that a long-context Alter needs a
cap several times its apparent context size.

Related: `budget_exceeded` is terminal by design (no retry), which is right for a
deterministic overrun — but combined with the above, an Alter can be killed for
re-reading and get no second chance, and `result.md` still holds whatever partial
text it had produced. Whatever is decided, a killed-mid-write artifact should be
easier to distinguish from a finished one than it is today.

## 7. Vision-level follow-ups (lower priority, exploratory)

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
