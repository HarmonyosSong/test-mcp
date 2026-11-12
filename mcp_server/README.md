# Harmony Repository MCP Server

This package is the read-only MCP capability boundary between the Mastra
diagnosis runtime and a repository snapshot or the Markdown knowledge base. It
does not orchestrate diagnosis runs and does not expose the web application's
AG-UI stream. The product runtime starts these servers on demand; this README
also documents their standalone stdio entry points.

## Responsibilities

- validate that every inspected path stays inside the authorized workspace;
- list and search allowed HarmonyOS, Python, build/configuration, and documentation files;
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

From the repository root, install the MCP dependencies with `make setup`. Then set the workspace directory and start the standalone stdio server:

```bash
HARMONY_AGENT_MCP_WORKSPACE=/absolute/path/to/snapshot \
  uv run --project mcp_server harmony-repository-mcp
```

The knowledge server is a separate stdio process and reads the repository knowledge tree:

```bash
HARMONY_AGENT_KNOWLEDGE_ROOT=/absolute/path/to/knowledge \
  uv run --project mcp_server harmony-knowledge-mcp
```

The standalone server reads the directory passed in `HARMONY_AGENT_MCP_WORKSPACE` directly; it does not create or verify a snapshot. Use a fixed copy if checks must be repeatable, because changes to that directory can affect later reads. The root [`mcp.json`](../mcp.json) contains a standalone repository-server client configuration for development inspection. The Mastra product runtime uses the same `uv run --project mcp_server ...` entry point but only starts it against the immutable archive snapshot selected by the current conversation's version registry; it has no local-directory binding path.

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
`make start` from the repository root. The product's Agent and HTTP request path
are owned by Mastra. Python Agent and FastAPI source/tests remain in `agent/`
and `server/` for historical review, but their Python project definitions and
lockfiles have been removed; they are not supported runtime or test entry
points. See the root migration specification for the remaining release gates.
