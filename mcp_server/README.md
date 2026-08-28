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
