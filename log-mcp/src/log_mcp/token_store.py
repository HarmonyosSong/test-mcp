"""OAuth 凭据存储：单文件 SQLite，两张表。

表结构见方案 5.4：
  - oauth_clients：注册的调用方（client_id + secret_hash + scopes + revoked）
  - oauth_tokens：签发的访问令牌（token_hash + client_id + scope + 过期时间）

只存 sha256(secret) 与 sha256(token)，库被拖走也拿不到可用凭据。
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

DEFAULT_TOKEN_TTL_SECONDS = 3600  # 1 小时


def _hash(value: str) -> str:
    """sha256 十六进制摘要。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


class TokenStore:
    """OAuth client + token 的 SQLite 存储；线程安全（每连接一把锁）。"""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # 限制权限为 0600，仅当前用户可读写
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_clients (
                    client_id      TEXT PRIMARY KEY,
                    secret_hash    TEXT NOT NULL,
                    description    TEXT NOT NULL DEFAULT '',
                    scopes         TEXT NOT NULL DEFAULT 'logs:read',
                    created_at     TEXT NOT NULL,
                    revoked        INTEGER NOT NULL DEFAULT 0
                )
                """,
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_tokens (
                    token_hash     TEXT PRIMARY KEY,
                    client_id      TEXT NOT NULL,
                    scope          TEXT NOT NULL,
                    issued_at      TEXT NOT NULL,
                    expires_at     TEXT NOT NULL
                )
                """,
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id)",
            )

    # ---------- client 管理 ----------

    def register_client(
        self,
        *,
        client_id: str,
        description: str = "",
        scopes: str = "logs:read",
    ) -> str:
        """注册或重置一个 client；返回仅此一次可见的 client_secret。"""
        client_secret = secrets.token_urlsafe(32)
        secret_hash = _hash(client_secret)
        created_at = _now().isoformat()
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO oauth_clients
                    (client_id, secret_hash, description, scopes, created_at, revoked)
                VALUES (?, ?, ?, ?, ?, 0)
                ON CONFLICT(client_id) DO UPDATE SET
                    secret_hash = excluded.secret_hash,
                    description = excluded.description,
                    scopes = excluded.scopes,
                    revoked = 0
                """,
                (client_id, secret_hash, description, scopes, created_at),
            )
        return client_secret

    def revoke_client(self, client_id: str) -> bool:
        """吊销 client；同时清理其名下所有 token。"""
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE oauth_clients SET revoked = 1 WHERE client_id = ? AND revoked = 0",
                (client_id,),
            )
            conn.execute("DELETE FROM oauth_tokens WHERE client_id = ?", (client_id,))
            return cur.rowcount > 0

    def list_clients(self) -> list[dict[str, Any]]:
        """列出所有 client（不含 secret）。"""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT client_id, description, scopes, created_at, revoked FROM oauth_clients",
            ).fetchall()
        return [
            {
                "client_id": r["client_id"],
                "description": r["description"],
                "scopes": r["scopes"],
                "created_at": r["created_at"],
                "revoked": bool(r["revoked"]),
            }
            for r in rows
        ]

    def verify_client(self, client_id: str, client_secret: str) -> str | None:
        """校验 client 凭据；通过返回 scopes，否则 None。"""
        secret_hash = _hash(client_secret)
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT secret_hash, scopes, revoked FROM oauth_clients WHERE client_id = ?",
                (client_id,),
            ).fetchone()
        if row is None or row["revoked"]:
            return None
        if not hmac.compare_digest(row["secret_hash"].encode(), secret_hash.encode()):
            return None
        return row["scopes"]

    # ---------- token 签发与校验 ----------

    def issue_token(
        self,
        *,
        client_id: str,
        scopes: str,
        ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS,
    ) -> tuple[str, int]:
        """签发 access_token；返回 (token, expires_in)。"""
        access_token = secrets.token_urlsafe(32)
        token_hash = _hash(access_token)
        issued = _now()
        expires = issued + timedelta(seconds=ttl_seconds)
        with self._lock, self._conn() as conn:
            conn.execute(
                """
                INSERT INTO oauth_tokens (token_hash, client_id, scope, issued_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (token_hash, client_id, scopes, issued.isoformat(), expires.isoformat()),
            )
        return access_token, ttl_seconds

    def verify_access_token(self, authorization_header: str | None) -> tuple[str, str] | None:
        """校验 Bearer access_token；通过返回 (client_id, scope)，否则 None。

        不区分「不存在」与「已过期」，避免探测（方案 5.6）。
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
                SELECT t.client_id, t.scope, t.expires_at, c.revoked
                FROM oauth_tokens t
                JOIN oauth_clients c ON c.client_id = t.client_id
                WHERE t.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
        if row is None or row["revoked"]:
            return None
        expires_at = datetime.fromisoformat(row["expires_at"])
        if expires_at <= _now():
            return None
        return row["client_id"], row["scope"]

    def revoke_token(self, token: str, client_id: str, client_secret: str) -> bool:
        """吊销 access_token；用 client_id + client_secret 自证（RFC 7009 容错）。"""
        if self.verify_client(client_id, client_secret) is None:
            return False
        token_hash = _hash(token)
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?",
                (token_hash, client_id),
            )
        return cur.rowcount > 0

    def cleanup_expired(self) -> int:
        """清理过期 token；返回清理条数。"""
        now_iso = _now().isoformat()
        with self._lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM oauth_tokens WHERE expires_at <= ?", (now_iso,))
        return cur.rowcount

    def close(self) -> None:
        """SQLite 连接按需创建与关闭，无需持久化资源。"""
        return None
