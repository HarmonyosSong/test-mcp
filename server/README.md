# Legacy Python HTTP Server Reference

This directory contains the retired FastAPI application and tests as historical API behavior references. It is no longer an installable Python project or a supported runtime/test entry point.

The product HTTP/API runtime is `runtime/`, implemented with Mastra and Hono. Use `make dev-api` for development or `make start` for the production build. Python MCP domain services are independent and remain under `mcp_server/`.
