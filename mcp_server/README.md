# Harmony Repository MCP Server

This package is the read-only tool boundary between the diagnosis agent and a
repository snapshot. It does not orchestrate diagnosis runs and does not expose
the web application's AG-UI stream.

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

Set the immutable repository snapshot and start the stdio server:

```bash
HARMONY_AGENT_MCP_WORKSPACE=/absolute/path/to/snapshot \
  uv run --project mcp_server harmony-repository-mcp
```

The root [`mcp.json`](../mcp.json) contains the equivalent client configuration.

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
