"""测试公共夹具。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 让 `log_mcp` 包可被导入（src 布局）
ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# 测试默认走本地数据根，避免污染真实数据盘
os.environ.setdefault("HARMONY_AGENT_DATA_ROOT", str(ROOT / ".data"))

# 直接调 call_tool 的测试（绕过 ASGI 鉴权）需要一个默认的鉴权上下文。
# TestClient 测试由 BearerAuthDispatcher 按请求覆盖此值。
from log_mcp.auth_context import CLIENT_ID, CLIENT_SCOPE  # noqa: E402

CLIENT_ID.set("test-client")
CLIENT_SCOPE.set("logs:read")


def make_settings(tmp_path, *, auth_disabled: bool = True, host: str = "127.0.0.1"):
    """构造带测试凭据的 Settings，避免 auth_headers 抛 ValueError。"""
    from log_mcp.config import Settings

    return Settings(
        data_root=str(tmp_path),
        auth={"disabled": auth_disabled},
        host=host,
        env="test",
        gateway={
            "prod": {
                "baseUrl": "https://logcenter-api.tal.com/api",
                "appid": "test-appid",
                "appsecret": "test-secret",
            },
            "test": {
                "baseUrl": "https://logcenter-api-test.tal.com/api",
                "appid": "test-appid",
                "appsecret": "test-secret",
            },
        },
        cloudlog={
            "vendor": "aliyun",
            "defaults": {
                "region": "cn-beijing",
                "account": "1743276692096170",
                "collection": "pysy-front-log",
            },
        },
    )
