# `mind`

The command-line distribution of Alter Spawner. It creates and operates projects
whose work is decomposed into isolated Alters, spikes, graphs, and oscillations.

```bash
npm install --global mind
mkdir my-agent && cd my-agent
mind init
mind spawn --catalog researcher "Investigate this question."
mind spawn --image ./screenshot.png --model openai/gpt-4o "Describe the failure."
```

Repeat `--image <file>` to attach PNG, JPEG, GIF, or WebP inputs to an
image-capable model. The OpenCode, Codex, Grok, and direct `llm` executors support
validated image inputs. Select Codex with `--executor codex` and an OpenAI
model reference such as `--model openai/gpt-5.6-sol`. Select Grok with
`--executor grok` and an xAI model reference such as `--model xai/grok-4.5`.

Run `mind --help` for the command list and `mind --version` for the installed
version. Node.js 22.13 or newer is required.

The package is self-contained: it bundles the runtime and default profile, so the
CLI does not require a separate `@mind/core` installation.
