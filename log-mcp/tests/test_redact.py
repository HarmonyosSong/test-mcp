"""脱敏测试。"""

from __future__ import annotations

from log_mcp.clients.redact import redact


def test_redact_drops_undefined_keys() -> None:
    # Python dict 不存在 undefined，但 None 应保留
    assert redact({"a": 1, "b": None}) == {"a": 1, "b": None}


def test_redact_replaces_sensitive_keys() -> None:
    out = redact(
        {
            "Authorization": "Bearer abc",
            "cookie": "session=xyz",
            "token": "t1",
            "access_key": "k1",
            "access-key": "k2",
            "secret": "s1",
            "password": "p1",
            "passwd": "p2",
            "sign": "sg1",
            "session": "se1",
            "jwt": "j1",
            "normal": "value",
        }
    )
    for key in (
        "Authorization",
        "cookie",
        "token",
        "access_key",
        "access-key",
        "secret",
        "password",
        "passwd",
        "sign",
        "session",
        "jwt",
    ):
        assert out[key] == "<redacted>"
    assert out["normal"] == "value"


def test_redact_phone_in_string_value() -> None:
    assert redact("contact 13812345678 end") == "contact <phone> end"


def test_redact_id_card_in_string_value() -> None:
    # 17 位 + 1 位校验位（X 或数字）= 18 位身份证
    assert redact("id 11010119900307888X") == "id <id-card>"


def test_redact_url_param_token() -> None:
    assert (
        redact("https://x.com/api?token=abc123&keep=1")
        == "https://x.com/api?token=<redacted>&keep=1"
    )


def test_redact_nan_and_infinity_to_null() -> None:
    out = redact({"a": float("nan"), "b": float("inf"), "c": float("-inf"), "d": 1.5})
    assert out["a"] is None
    assert out["b"] is None
    assert out["c"] is None
    assert out["d"] == 1.5


def test_redact_recursive_list_and_dict() -> None:
    out = redact([{"token": "x", "nested": [{"password": "p"}]}, "phone 13900001111"])
    assert out[0]["token"] == "<redacted>"
    assert out[0]["nested"][0]["password"] == "<redacted>"
    assert out[1] == "phone <phone>"


def test_redact_full_true_still_redacts() -> None:
    """full=true 也过脱敏（方案 4 节）。"""
    out = redact({"@timestamp": 123, "token": "secret", "message": "phone 13800001111"})
    assert out["token"] == "<redacted>"
    assert out["message"] == "phone <phone>"
    assert out["@timestamp"] == 123
