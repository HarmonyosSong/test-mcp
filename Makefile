.PHONY: setup check-node dev-api dev-server dev-web dev-mcp test test-runtime test-mcp knowledge-validate lint build build-runtime build-web start live-eval knowledge-querylog knowledge-cases

setup: check-node
	uv sync --project mcp_server --index-url https://pypi.org/simple
	npm --prefix web install
	npm --prefix runtime ci

check-node:
	@node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error('Node.js >=22.13.0 is required'); process.exit(1); }"

dev-api: check-node
	npm --prefix runtime run dev

dev-server: dev-api

dev-web:
	npm --prefix web run dev

dev-mcp:
	uv run --project mcp_server harmony-repository-mcp

knowledge-validate:
	uv run --project mcp_server harmony-knowledge-validate

test: test-runtime test-mcp knowledge-validate

test-runtime: check-node
	npm --prefix runtime test

test-mcp:
	uv run --project mcp_server pytest -q mcp_server/tests

lint:
	$(MAKE) check-node
	npm --prefix runtime run typecheck
	npm --prefix web run build
	uv run --project mcp_server ruff check --ignore I001 mcp_server
	uv run --project mcp_server ruff format --check --exclude 'mcp_server/src/harmony_knowledge_mcp/retrieval_rules.py' mcp_server

build: build-runtime build-web

build-runtime: check-node
	npm --prefix runtime run build

build-web:
	npm --prefix web run build

start: build-runtime build-web check-node
	HARMONY_MASTRA_SERVE_WEB=true npm --prefix runtime start

# Live evaluation fails when the model is absent; it never silently skips.
live-eval: check-node
	npm --prefix runtime run live-eval -- --live runtime/src/evaluation/datasets/live_chat.jsonl --output .data/evals/latest.json

knowledge-querylog:
	uv run --project mcp_server harmony-knowledge-querylog

knowledge-cases:
	npm --prefix runtime run cases -- list
