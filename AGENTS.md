# Project Instructions

## Knowledge Changes

When changing `knowledge/`, the knowledge MCP, or knowledge retrieval instructions:

- Read `knowledge/AGENTS.md` and `knowledge/_schema.md` before editing.
- Keep facts at `facts/<domain>/<name>.md`, with one canonical entry and a globally unique, stable ID.
- Treat domain preferences as ranking context, never as a hard retrieval filter or evidence authority.
- Preserve cross-domain references and the global fallback described in `knowledge/README.md`.
- For runtime or Skill integration, follow `docs/decisions/0002-runtime-knowledge-budget.md`:
  preserve tool-call pairs, require observed evidence, and evaluate cost alongside diagnosis quality.
- Run `make knowledge-validate`. For loader, retriever, or MCP changes, also run
  `uv run --project mcp_server pytest -q mcp_server/tests/test_knowledge_base.py mcp_server/tests/test_query_log.py`.
