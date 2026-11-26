"""compact_util：href 去 token、ua 摘要、response 摘要、预算。"""

from __future__ import annotations

from log_mcp.tools.cloudlog import _compact_cloud_log
from log_mcp.tools.compact_util import (
    scrub_currenthref,
    slim_response_field,
    summarize_ua,
)
from log_mcp.tools.logcenter import _compact_data_field, _compact_log


def test_scrub_currenthref_strips_token_keeps_business_params() -> None:
    url = (
        "https://vmall.speiyou.com/path?token=SECRET&uid=5570040&from=home"
        "&access_token=ALSO&ticket=T1"
    )
    cleaned = scrub_currenthref(url)
    assert "token=" not in cleaned
    assert "access_token=" not in cleaned
    assert "ticket=" not in cleaned
    assert "uid=5570040" in cleaned
    assert "from=home" in cleaned
    assert cleaned.startswith("https://vmall.speiyou.com/path?")


def test_summarize_ua_extracts_device_fields() -> None:
    ua = (
        "Mozilla/5.0 (Linux; Android 13; TALIH-PD2A Build/TP1A.220624.014; wv) "
        "AppleWebKit/537.36 version=5.106.0 clientType=28 source=dzjj "
        "dv=TAL2205E41686A31F93FBFBA3A5628D52A67ECD env=release"
    )
    summary = summarize_ua(ua)
    assert summary.get("version") == "5.106.0"
    assert summary.get("clientType") == "28"
    assert summary.get("OS") == "Android"
    assert "osVersion" in summary
    assert summary.get("dv", "").startswith("TAL2205")


def test_slim_response_keeps_code_message_only() -> None:
    raw = {
        "message": "成功",
        "code": "000000",
        "data": {"items": [{"rank": 1}] * 100},
    }
    import json

    slim = slim_response_field(json.dumps(raw, ensure_ascii=False))
    assert slim == {"code": "000000", "message": "成功"}


def test_compact_cloud_log_applies_href_and_ua_summary() -> None:
    row = _compact_cloud_log(
        {
            "uid": "5570040",
            "eventid": "SAVE",
            "currenthref": "https://x.com/a?token=SECRET&uid=5570040",
            "ua": "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) version=5.1.0 clientType=5",
            "rsd": "dv=TALABCDEF0123456789ABCDEF01234567 version=5.1.0",
            "noise": "drop-me",
        }
    )
    assert "noise" not in row
    assert "ua" not in row
    assert "rsd" not in row
    assert "token=" not in row["currenthref"]
    assert "uid=5570040" in row["currenthref"]
    assert row["ua_summary"]["version"] == "5.1.0"
    assert row.get("OS") == "iOS" or "iPad" in str(row.get("ua_summary"))


def test_compact_log_data_and_c_subsets() -> None:
    log = {
        "@timestamp": "2026-11-25T00:00:00Z",
        "ua": "Mozilla/5.0 (Linux; Android 11; XTW31) version=5.106.0 clientType=5",
        "c": {
            "monitorLogType": "1",
            "pp": {
                "uid": "5570040",
                "clientIdentifier": "ABC",
                "ver": "5.1",
                "noise": "x",
            },
            "jsBridgeInfo": {
                "eventname": "nav",
                "desc": "ok",
                "exception": "{}",
                "extra": "drop",
            },
            "huge": {"a": 1},
        },
        "data": {
            "eventid": "english-library-fe",
            "status": "200",
            "method": "GET",
            "response": '{"code":"000000","message":"成功","data":{"items":[1,2,3]}}',
            "performanceResourceTiming": {"duration": 1},
            "rsd": "Mozilla/... long",
            "gitOriginUrl": "fe_log_sdk:...",
        },
    }
    out = _compact_log(log)
    assert "ua" not in out
    assert out["c"]["pp"] == {"uid": "5570040", "clientIdentifier": "ABC", "ver": "5.1"}
    assert "huge" not in out["c"]
    assert out["c"]["jsBridgeInfo"]["eventname"] == "nav"
    assert "extra" not in out["c"]["jsBridgeInfo"]
    assert out["data"]["response"] == {"code": "000000", "message": "成功"}
    assert "performanceResourceTiming" not in out["data"]
    assert "rsd" not in out["data"]
    assert "gitOriginUrl" not in out["data"]
    assert out["data"]["eventid"] == "english-library-fe"


def test_compact_data_field_scrubs_href() -> None:
    data = _compact_data_field(
        {
            "currenthref": "https://h5.example/rank?token=ABC&gradeId=2",
            "resourceUrl": "https://api.example/rank",
            "response": {"code": "1", "msg": "fail", "data": {"x": 1}},
        }
    )
    assert "token=" not in data["currenthref"]
    assert "gradeId=2" in data["currenthref"]
    assert data["response"] == {"code": "1", "message": "fail"}


def test_compact_cloud_log_keeps_short_ua_excerpt_when_unparseable() -> None:
    """摘要抽不出字段时保留极短占位（P0-2），不静默丢设备线索。"""
    row = _compact_cloud_log({"uid": "1", "ua": "curl/8.0"})
    assert "ua" not in row
    assert "ua_summary" not in row
    assert row["ua_excerpt"] == "curl/8.0"
    # 超长 UA 只留开头占位
    long_ua = "x" * 200
    row2 = _compact_cloud_log({"uid": "1", "ua": long_ua})
    assert row2["ua_excerpt"].endswith("…")
    assert len(row2["ua_excerpt"]) <= 81


def test_compact_log_ua_excerpt_placeholder() -> None:
    row = _compact_log({"@timestamp": 1, "ua": "okhttp/4.12.0"})
    assert "ua" not in row
    assert row.get("ua_excerpt") == "okhttp/4.12.0"
    # 完全无 ua/rsd 时不放占位
    row2 = _compact_log({"@timestamp": 1})
    assert "ua_excerpt" not in row2
    assert "ua_summary" not in row2


def test_apply_budget_clip_false_keeps_full_fields() -> None:
    """full=true：不逐字段截断，只保留总预算护栏。"""
    from log_mcp.tools.compact_util import VALUE_MAX_CHARS, apply_budget_to_log_rows

    long_value = "y" * (VALUE_MAX_CHARS + 500)
    kept, meta = apply_budget_to_log_rows([{"message": long_value}], clip=False)
    assert kept[0]["message"] == long_value
    assert meta == {}
    # clip=True（默认）维持逐字段截断
    kept2, _ = apply_budget_to_log_rows([{"message": long_value}])
    assert len(kept2[0]["message"]) == VALUE_MAX_CHARS
    assert kept2[0]["message"].endswith("…")
