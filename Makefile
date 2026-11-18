.PHONY: setup check-node dev-api dev-server dev-web dev-mcp dev-log-mcp stop-log-mcp bootstrap-sources test test-runtime test-mcp knowledge-validate lint build build-runtime build-web start live-eval knowledge-querylog knowledge-cases

setup: check-node
	uv sync --project mcp_server --index-url https://pypi.org/simple
	uv sync --project log-mcp --index-url https://pypi.org/simple
	npm --prefix web install
	npm --prefix runtime ci

# 首次部署/本地运行：把 sources.json 全部版本窗的壳+组件快照物化到运行时缓存
# （默认 .data/workspaces），诊断时直接命中。幂等，可随时重跑。
# 大仓库建议 HARMONY_AGENT_GITLAB_TIMEOUT_MS=300000 make bootstrap-sources
bootstrap-sources: check-node
	npx tsx code-index/warm-runtime-cache.ts


check-node:
	@node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error('Node.js >=22.13.0 is required'); process.exit(1); }"

# 后台起 log-mcp（:8766）；本地开发固定走生产网关（LOG_MCP_ENV=prod）
# 失败只告警，不挡 Agent
dev-log-mcp:
	@if [ ! -d log-mcp ]; then echo "make: skip log-mcp (directory missing)"; exit 0; fi
	@set -a; [ -f .env ] && . ./.env; set +a; \
		host="$${LOG_MCP_HOST:-127.0.0.1}"; port="$${LOG_MCP_PORT:-8766}"; \
		echo "make: log-mcp 关键配置:"; \
		echo "  LOG_MCP_ENV=prod  (make 强制，走生产网关)"; \
		echo "  LOG_MCP_HOST=$$host"; \
		echo "  LOG_MCP_PORT=$$port"; \
		echo "  LOG_MCP_URL=$${LOG_MCP_URL:-http://$$host:$$port/mcp}"; \
		echo "  LOG_MCP_AUTH_DISABLED=$${LOG_MCP_AUTH_DISABLED:-false}"; \
		if [ -n "$$LOG_MCP_BEARER_TOKEN" ]; then bt='<set>'; else bt='<empty>'; fi; \
		if [ -n "$$LOG_MCP_PROD_APPSECRET" ]; then ps='<set>'; else ps='<empty>'; fi; \
		echo "  LOG_MCP_BEARER_TOKEN=$$bt"; \
		echo "  LOG_MCP_PROD_APPID=$${LOG_MCP_PROD_APPID:-<empty>}"; \
		echo "  LOG_MCP_PROD_BASE_URL=$${LOG_MCP_PROD_BASE_URL:-<empty>}"; \
		echo "  LOG_MCP_PROD_APPSECRET=$$ps"; \
		echo "  LOG_MCP_CLOUDLOG_ACCOUNT=$${LOG_MCP_CLOUDLOG_ACCOUNT:-<empty>}"; \
		echo "  LOG_MCP_CLOUDLOG_COLLECTION=$${LOG_MCP_CLOUDLOG_COLLECTION:-<empty>}"
	@cd log-mcp && uv sync --quiet \
		&& LOG_MCP_ENV=prod uv run start --background \
		|| echo "make: WARN log-mcp 启动失败，Agent 仍继续（可稍后 make dev-log-mcp）" >&2

stop-log-mcp:
	@cd log-mcp && uv run stop 2>/dev/null || true

# 本地开发：先起独立 log-mcp，再前台跑 Agent；Ctrl+C 时停掉 log-mcp
dev-api: check-node
	@$(MAKE) dev-log-mcp
	@trap '$(MAKE) stop-log-mcp' EXIT INT TERM; npm --prefix runtime run dev

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

# 本地生产模式：同样附带后台 log-mcp（与容器入口行为对齐）
start: build-runtime build-web check-node
	@$(MAKE) dev-log-mcp
	@trap '$(MAKE) stop-log-mcp' EXIT INT TERM; \
		HARMONY_MASTRA_SERVE_WEB=true npm --prefix runtime start

# Live evaluation fails when the model is absent; it never silently skips.
live-eval: check-node
	npm --prefix runtime run live-eval -- --live runtime/src/evaluation/datasets/live_chat.jsonl --output .data/evals/latest.json

knowledge-querylog:
	uv run --project mcp_server harmony-knowledge-querylog

knowledge-cases:
	npm --prefix runtime run cases -- list
