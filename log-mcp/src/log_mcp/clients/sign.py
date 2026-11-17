"""日志中心 Skill OpenAPI 认证签名。

移植自 `dev-agent-logs/src/appx/sign.mjs`，逻辑不变：
  sign = md5(appid + '&' + timestamp + appsecret)
  请求头：X-Sign-Appid / X-Sign-TimeStamp / X-Sign-Sign
Token 有效期 5 分钟，每次调用生成新的时间戳 + 签名。
"""

from __future__ import annotations

import hashlib
import time
from typing import Any


def generate_sign(appid: str, timestamp: int, appsecret: str) -> str:
    """生成签名：md5(appid & ts + appsecret)。"""
    sign_str = f"{appid}&{timestamp}{appsecret}"
    return hashlib.md5(sign_str.encode("utf-8")).hexdigest()  # noqa: S324


def auth_headers(cred: Any, now: int | None = None) -> dict[str, str]:
    """构造签名请求头。

    `cred` 需有 `appid` / `appsecret`（SecretStr 或 str）。
    """
    appid = getattr(cred, "appid", "")
    secret = getattr(cred, "appsecret", None)
    if hasattr(secret, "get_secret_value"):
        secret = secret.get_secret_value()
    if not appid or not secret:
        raise ValueError("未配置日志中心凭据（appid/appsecret）")
    ts = int(now if now is not None else time.time())
    sign = generate_sign(appid, ts, str(secret))
    return {
        "X-Sign-Appid": str(appid),
        "X-Sign-TimeStamp": str(ts),
        "X-Sign-Sign": sign,
        "Accept": "application/json",
    }
