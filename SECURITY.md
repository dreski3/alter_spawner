# Security

Do not report vulnerabilities in public issues until a private reporting channel
is listed in this document. Until then, contact the repository owner directly
through the account that hosts the canonical repository.

Alter Spawner treats project files, catalog manifests, model output, imported
Alter projects, and persistent-memory content as untrusted data. Trusted
capability implementations and credentials must remain in the host. Importing a
catalog drops privileged fields by default; `--trust` is an explicit security
boundary, not a convenience flag.

When reporting a vulnerability, include the affected version or commit, the
smallest reproduction, expected and observed isolation boundaries, and whether
credentials, host capabilities, filesystem paths, or cross-agent data can be
reached. Never include live secrets or private memory contents.
