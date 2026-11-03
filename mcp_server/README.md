# Harmony Repository MCP Server

This package is the read-only MCP capability boundary between the Mastra
diagnosis runtime and a repository snapshot or the Markdown knowledge base. It
does not orchestrate diagnosis runs and does not expose the web application's
AG-UI stream. The product runtime starts these servers on demand; this README
also documents their standalone stdio entry points.

## Responsibilities

- validate that every inspected path stays inside the authorized snapshot;
- list and search allowed source and documentation files;
- read bounded source ranges;
- parse pasted HiLog output;
- load repository-local business context as untrusted evidence.

## Layout

```text
mcp_server/
├── src/harmony_repo_mcp/
│   ├── server.py       # FastMCP composition and stdio entry point
│   ├── inspector.py    # read-only filesystem boundary
│   ├── schemas.py      # structured tool results
│   └── tools/          # MCP tool registration modules
└── tests/
```

## Run

From the repository root, install the MCP dependencies with `make setup`. Then set the immutable repository snapshot and start the standalone stdio server:

```bash
HARMONY_AGENT_MCP_WORKSPACE=/absolute/path/to/snapshot \
  uv run --project mcp_server harmony-repository-mcp
```

The root [`mcp.json`](../mcp.json) contains a standalone repository-server client configuration. The Mastra runtime uses the same `uv run --project mcp_server ...` entry points and creates its own per-conversation repository client.

## Tools

- `list_project_files`
- `search_project_text`
- `read_project_file`
- `parse_hilog`
- `load_business_context`

Repository content is treated as untrusted input. Tool annotations declare all
operations read-only and non-destructive.

## Knowledge MCP

`harmony-knowledge-mcp` loads the Markdown knowledge tree separately from repository evidence.
Facts live at `facts/<domain>/<name>.md`; symptoms remain at `symptoms/<name>.md`.
Entry IDs are globally unique and references resolve across domains.

- `list_symptoms`: symptom names, aliases, and candidate domains.
- `lookup_issue`: default business-symptom entry point; automatic fact fallback and bounded previews
  of the leading candidate and its direct references, avoiding mandatory separate reads.
- `list_knowledge_domains`: domain IDs present in the loaded entries.
- `search_knowledge`: search symptoms, facts, or both; optional `domains` prefer matching domains
  and `shared` at equal text scores. Other domains remain eligible.
- `get_knowledge_entry`: read body pages by stable ID (`offset`, `limit`, `next_offset`), regardless of directory.

Run `make knowledge-validate` from the repository root after editing content. See
[`knowledge/_schema.md`](../knowledge/_schema.md) for layout and metadata constraints.
Domain preferences and matched domains are included in query logs for retrieval evaluation.

## Product runtime

For the complete application flow, start `runtime/` through `make dev-api` or
`make start` from the repository root. Do not start the old `server/` FastAPI
application to run the product; `server/` and `agent/` remain legacy tests,
evaluation tools, and domain references while the user-facing Agent and HTTP
runtime are owned by Mastra.
