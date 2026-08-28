.PHONY: setup dev-api dev-server dev-web dev-mcp test lint build

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

test:
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
