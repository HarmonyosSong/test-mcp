# Upstream Contract

Source: https://git.100tal.com/peiyou_app_ai/dev-knowledge.git

Pinned commit: `ee30c3b739388f829f91adac13677ae2bf33a496` (2026-09-24).

The public `contracts/` bundle is copied unchanged, not the knowledge content or server code.
`manifest.json` verifies schema/example hashes. The Python compatibility copy under `agent/` is retained for historical review and is not an active consumer. Update and validate the active Mastra bundle under `runtime/contracts/dev-knowledge/` with `make test-runtime`.
The adapter also checks requested scope, query echo, citation closure and bounded output.
The upstream server runs in its own environment; its MCP SDK version is not installed in this runtime.
