"""签名测试。"""

from __future__ import annotations

import hashlib

from log_mcp.clients.sign import auth_headers, generate_sign


def test_generate_sign_md5() -> None:
    sign = generate_sign("appid123", 1700000000, "secret456")
    expected = hashlib.md5(b"appid123&1700000000secret456").hexdigest()  # noqa: S324
    assert sign == expected


def test_auth_headers_format() -> None:
    class Cred:
        appid = "app1"
        appsecret = "sec1"

    headers = auth_headers(Cred(), now=1700000000)
    assert headers["X-Sign-Appid"] == "app1"
    assert headers["X-Sign-TimeStamp"] == "1700000000"
    assert headers["X-Sign-Sign"] == generate_sign("app1", 1700000000, "sec1")
    assert headers["Accept"] == "application/json"


def test_auth_headers_support_secretstr() -> None:
    from pydantic import SecretStr

    class Cred:
        appid = "app1"
        appsecret = SecretStr("sec1")

    headers = auth_headers(Cred(), now=1700000000)
    assert headers["X-Sign-Sign"] == generate_sign("app1", 1700000000, "sec1")


def test_auth_headers_missing_cred_raises() -> None:
    class Cred:
        appid = ""
        appsecret = ""

    import pytest

    with pytest.raises(ValueError):
        auth_headers(Cred())
