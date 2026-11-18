"""调用方 API Token 存储：单文件 SQLite，一张表。

每调用方一条长期 Bearer token（带过期）：
  - 库内只存 sha256(token)
  - ctl `client issue` 颁发；请求头 Bearer 校验
  - 吊销 / 过期均拒绝，不区分原因
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

DEFAULT_TOKEN_TTL_DAYS = 180


def _hash(value: str) -> str:
    """sha256 十六进制摘要。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


class TokenStore:
    """长期 API Token 的 SQLite 存储；线程安全。"""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        if not db_path.exists():
            db_path.touch()
        try:
            db_path.chmod(0o600)
        except OSError:
            pass
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._lock, self._conn() as conn:
            # 旧 OAuth 两表废弃；本地/测试库直接丢弃后重建
            conn.execute("DROP TABLE IF EXISTS oauth_tokens")
            conn.execute("DROP TABLE IF EXISTS oauth_clients")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS api_tokens (
                    client_id      TEXT PRIMARY KEY,
                    token_hash     TEXT NOT NULL,
                    description    TEXT NOT NULL DEFAULT '',
                    scopes         TEXT NOT NULL DEFAULT 'logs:read',
                    created_at     TEXT NOT NULL,
                    expires_at     TEXT NOT NULL,
                    revoked        INTEGER NOT NULL DEFAULT 0
                )
                """,
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)",
            )

    def issue_token(
        self,
        *,
        client_id: str,
        description: str = "",
        scopes: str = "logs:read",
        ttl_days: int | None = None,
        ttl_seconds: int | None = None,
    ) -> tuple[str, int]:
        """颁发或轮换调用方 token；返回 (明文 token, expires_in 秒)。明文仅此一次可见。"""
        if ttl_seconds is not None:
            expires_in = max(0, int(ttl_seconds))
        else:
            days = DEFAULT_TOKEN_TTL_DAYS if ttl_days is None else int(ttl_days)
            expires_in = max(0, days * 86_400)
        token = secrets.token_urlsafe(32)
        token_hash = _hash(token)
        issued = _now()
        expires = issued + timedelta(seconds=expires_in)
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO api_tokens
                    (client_id, token_hash, description, scopes, created_at, expires_at, revoked)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(client_id) DO UPDATE SET
                    token_hash = excluded.token_hash,
                    description = excluded.description,
                    scopes = excluded.scopes,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at,
                    revoked = 0
                """,
                (
                    client_id,
                    token_hash,
                    description,
                    scopes,
                    issued.isoformat(),
                    expires.isoformat(),
                ),
            )
        return token, expires_in

    def revoke_client(self, client_id: str) -> bool:
        """吊销调用方 token。"""
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE api_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0",
                (client_id,),
            )
        return cur.rowcount > 0

    def list_clients(self) -> list[dict[str, Any]]:
        """列出调用方（不含明文 token）。"""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                """
                SELECT client_id, description, scopes, created_at, expires_at, revoked
                FROM api_tokens
                ORDER BY client_id
                """,
            ).fetchall()
        return [
            {
                "client_id": r["client_id"],
                "description": r["description"],
                "scopes": r["scopes"],
                "created_at": r["created_at"],
                "expires_at": r["expires_at"],
                "revoked": bool(r["revoked"]),
            }
            for r in rows
        ]

    def verify_access_token(self, authorization_header: str | None) -> tuple[str, str] | None:
        """校验 Bearer token；通过返回 (client_id, scope)，否则 None。

        不区分「不存在 / 吊销 / 过期」，避免探测。
        """
        if not authorization_header:
            return None
        scheme, sep, token = authorization_header.partition(" ")
        if sep != " " or scheme.lower() != "bearer" or not token:
            return None
        token_hash = _hash(token.strip())
        with self._lock, self._conn() as conn:
            row = conn.execute(
                """
                SELECT client_id, scopes, expires_at, revoked, token_hash
                FROM api_tokens
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
        if row is None or row["revoked"]:
            return None
        # 哈希再比一次，防御异常存储
        if not hmac.compare_digest(row["token_hash"].encode(), token_hash.encode()):
            return None
        expires_at = datetime.fromisoformat(row["expires_at"])
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at <= _now():
            return None
        return row["client_id"], row["scopes"]

    def cleanup_expired(self) -> int:
        """删除已过期行；返回条数。"""
        now_iso = _now().isoformat()
        with self._lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM api_tokens WHERE expires_at <= ?", (now_iso,))
        return cur.rowcount

    def close(self) -> None:
        """SQLite 连接按需创建与关闭，无需持久化资源。"""
        return None
