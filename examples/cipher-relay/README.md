# Cipher relay isolation demo

This demo places an opaque AES-256-GCM envelope in a local artifact store and
sends only a typed handle to a nestable relay Alter. The relay cannot decrypt,
decode, or accidentally rewrite the ciphertext. It must choose two catalog
Alters in sequence: one decryptor whose only permitted command holds the
correct key, then one decoder whose only permitted command understands the
resulting encoding.

The first child atomically transforms the stored artifact and returns another
short typed handle. Only the decoder's final `SECRET:` value enters the relay
context. The relay does not inherit child prompt history, tool calls, stderr,
steps, or token context. Each run has its own OpenCode session ID, home, result,
raw event log, and token accounting. Event logging is enabled only for this
demo through `opencode_event_log` in its generated config.

## Run one message

```bash
cd /path/to/alter_spawner
npm install

MIND_DEMO_MODEL="openai/gpt-5.4-mini-fast" \
node examples/cipher-relay/setup.mjs /tmp/mind-cipher-relay
node examples/cipher-relay/run-demo.mjs /tmp/mind-cipher-relay --limit 1
```

Replace that model with any tool-capable model available in your OpenCode
configuration if needed:

```bash
MIND_DEMO_MODEL="your-provider/your-model" \
node examples/cipher-relay/setup.mjs /tmp/mind-cipher-relay
```

Run all four cipher/encoding combinations:

```bash
node examples/cipher-relay/run-demo.mjs /tmp/mind-cipher-relay --limit 4
```

Run one named case with `--case alpha-base64`, `beta-hex`, `alpha-url`, or
`beta-base64`.

Inspect the run hierarchy and isolation audit:

```bash
(cd /tmp/mind-cipher-relay && \
  node "$OLDPWD/packages/cli/src/index.js" tree)
cat /tmp/mind-cipher-relay/.alters/cipher-relay-audit.json
```

Every relay run contains exactly two child homes under its own `.alters/runs/`.

## Generate fresh envelopes

```bash
node examples/cipher-relay/tools/make-fixtures.mjs
```

The keys are intentionally embedded in the two demonstration decryptor tools.
They are not production secrets, and this example is not a key-management
design.
