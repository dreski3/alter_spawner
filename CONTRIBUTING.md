# Contributing

Alter Spawner requires Node.js 22.13 or newer and uses npm workspaces.

```bash
npm ci
npm run validate
```

`validate` checks JavaScript syntax, runs the offline unit and integration suite,
and inspects both package tarballs. Live provider tests are opt-in and require
the environment variables documented in the root README.

Keep runtime behavior in `packages/core`; CLI commands should parse terminal
input, call core, and render the result. Public core exports belong in both
`packages/core/src/index.js` and `packages/core/src/index.d.ts`. The public API
integration test detects runtime exports that have no declaration.

The default profile is authored once in `packages/cli/profiles/default`. Core's
prepack step copies it into the standalone library artifact so `initMind()` also
works for core-only consumers. Change the source profile, never generated
`packages/core/dist` or `packages/cli/dist` files.

Persisted formats carry schema versions. A format change needs a migration or an
explicit compatibility decision, fixtures covering old data, and a changelog
entry. Do not commit run homes, memory, tree ledgers, oscillation state, package
tarballs, credentials, or provider event logs.

Before a release, update the changelog and versions together, run `npm run
validate` from a clean checkout, inspect the tarball file lists, and perform the
consumer smoke tests described in `ROADMAP.md`.
