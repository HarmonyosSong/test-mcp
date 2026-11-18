#!/usr/bin/env python3
"""兼容入口：`uv run python manage.py ...` 仍可用；推荐改用短命令。

短命令（需先 uv sync）：
  uv run start              # 默认前台（日志打终端，Ctrl+C 停）
  uv run start --background # 后台守护
  uv run stop
  uv run restart
  uv run restart -d
  uv run status
  uv run check
  uv run client issue --client-id ... [--days 180]
"""

from __future__ import annotations

import sys

from log_mcp.ctl import main

if __name__ == "__main__":
    sys.exit(main())
