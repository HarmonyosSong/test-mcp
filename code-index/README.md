# Code Index

`index.jsonl` is a generated, version-scoped catalog of module, file, and symbol pointers. It does not contain source code or diagnosis conclusions. Each record must include the platform, product line, form factor, version, repository, and immutable commit.

The initial replacement window is configured in `version-scope.json`:

- mobile/default: `7.106.0`, `7.105.0`
- HD/pad: `5.105.0`, `7.105.0`

Replace the JSONL contents when the source window changes; the MCP contract and Agent tools remain unchanged. Query it through `search_code_index`, then read the returned path with the repository MCP bound to the same commit.

## Regenerate from source

`sources.json` is the replaceable scope definition. `prepare-sources.ts` resolves each
platform/version through `version-registry/`, verifies the immutable GitLab commit,
and materializes snapshots under `.data/code-index/workspaces/`. It records failures
instead of falling back to a nearby version.

```bash
cd runtime
node_modules/.bin/tsx ../code-index/prepare-sources.ts
cd ..
python3 code-index/generate.py
```

`generate.py` scans only the prepared snapshots and writes `index.jsonl` plus
`coverage.json`. A module entry is a real lexical source mapping: repository, commit,
relative file path, symbol, line anchor, and matched-file count. The index contains no
source body and is navigation-only; the repository MCP must read the same commit for
evidence. `coverage.json` lists prepared and unavailable exact versions, so an absent
snapshot cannot be mistaken for a mapping.
