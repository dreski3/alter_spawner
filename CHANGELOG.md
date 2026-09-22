# Changelog

All notable changes will be documented here. The project follows Semantic
Versioning once public releases begin.

## 0.1.0 - Unreleased

- Added a Codex CLI coding harness with resumable sessions, image inputs,
  normalized JSONL usage and tool events, cancellation, and least-privilege
  filesystem and web-search profiles.
- Added project-configured direct inference over OpenAI Responses, Anthropic
  Messages, Gemini, and generic OpenAI-compatible endpoints, with OpenCode
  provider discovery retained as a compatibility fallback.
- Added bounded image attachments for image-capable Alters across the
  CLI, embedded API, reruns, and graph nodes, with modality checks and safe run metadata.
- Added isolated Alter execution with retry, fallback, cancellation, output
  contracts, nested tree budgets, and durable run traces.
- Added dependency graphs with parallel branches, progress events, and stable
  per-cycle memory recall and curation.
- Added JSON and SQLite persistent-memory backends, host capability approvals,
  maintenance graphs, and compaction accounting.
- Added spikes, phased oscillations, refractory scheduling, a mind registry, and
  daemon execution.
- Added self-contained CLI and standalone core package artifacts with external
  installation tests.
- Made SQLite lexical retrieval portable across Node builds with and without the
  optional FTS5 module.
