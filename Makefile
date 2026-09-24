.PHONY: setup dev-api dev-server dev-web dev-mcp test knowledge-validate lint build live-eval knowledge-querylog knowledge-cases

setup:
	uv sync --project agent --index-url https://pypi.org/simple
	uv sync --project server --index-url https://pypi.org/simple
	uv sync --project mcp_server --index-url https://pypi.org/simple
	npm --prefix web install

dev-api:
	uv run --project server harmony-agent-server

dev-server:
	uv run --project server harmony-agent-server

dev-web:
	npm --prefix web run dev

dev-mcp:
	uv run --project mcp_server harmony-repository-mcp

knowledge-validate:
	uv run --project mcp_server harmony-knowledge-validate

test: knowledge-validate
	uv run --project server pytest -q

lint:
	uv run --project agent ruff check agent
	uv run --project agent ruff format --check agent
	uv run --project server ruff check server
	uv run --project server ruff format --check server
	uv run --project mcp_server ruff check mcp_server
	uv run --project mcp_server ruff format --check mcp_server

build:
	npm --prefix web run build

# Live evaluation fails when the model is absent; it never silently skips.
live-eval:
	uv run --project server python -m harmony_agent.evaluation --live agent/evals/datasets/live_chat.jsonl --output .data/evals/latest.json

knowledge-querylog:
	uv run --project mcp_server harmony-knowledge-querylog

knowledge-cases:
	uv run --project server python -m harmony_agent.knowledge_feedback list
