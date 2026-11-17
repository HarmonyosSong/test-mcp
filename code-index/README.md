# Code Index

`index.jsonl` is a generated, version-scoped catalog of module, file, and symbol pointers. It does not contain source code or diagnosis conclusions. Each record must include the platform, product line, form factor, version, repository, and immutable commit.

The initial replacement window is configured in `version-scope.json`:

- mobile/default: `7.106.0`, `7.105.0`
- HD/pad: `5.105.0`, `7.105.0`

Replace the JSONL contents when the source window changes; the MCP contract and Agent tools remain unchanged. Query it through `search_code_index`, then read the returned path with the repository MCP bound to the same commit.
