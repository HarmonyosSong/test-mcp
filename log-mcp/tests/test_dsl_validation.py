"""DSL 校验测试（方案 4.1）。"""

from __future__ import annotations

import pytest

from log_mcp.errors import LogMcpToolError
from log_mcp.tools.logcenter import _validate_dsl


def test_dsl_must_be_object() -> None:
    with pytest.raises(LogMcpToolError) as exc:
        _validate_dsl([{"size": 1}], None, None)
    assert exc.value.code == "bad_request"


def test_dsl_forbids_script_any_level() -> None:
    with pytest.raises(LogMcpToolError) as exc:
        _validate_dsl({"query": {"script": {"source": "1+1"}}}, None, None)
    assert exc.value.code == "bad_request"
    assert "script" in exc.value.message


def test_dsl_forbids_script_fields() -> None:
    with pytest.raises(LogMcpToolError) as exc:
        _validate_dsl({"script_fields": {"x": {"script": "1"}}}, None, None)
    assert exc.value.code == "bad_request"


def test_dsl_size_range() -> None:
    with pytest.raises(LogMcpToolError):
        _validate_dsl({"size": 201}, None, None)
    with pytest.raises(LogMcpToolError):
        _validate_dsl({"size": -1}, None, None)
    # 0 与 200 合法
    _validate_dsl({"size": 0}, None, None)
    _validate_dsl({"size": 200}, None, None)


def test_dsl_from_size_sum_limit() -> None:
    with pytest.raises(LogMcpToolError) as exc:
        _validate_dsl({}, size=200, from_=9900)
    assert "10000" in exc.value.message
    assert "search_after" in exc.value.message


def test_dsl_from_and_search_after_mutex() -> None:
    with pytest.raises(LogMcpToolError) as exc:
        _validate_dsl({"search_after": [1]}, size=10, from_=0)
    assert "search_after" in exc.value.message


def test_dsl_cli_overrides_dsl_body() -> None:
    """CLI size/from 优先于 DSL 顶层。"""
    resolved_size, resolved_from = _validate_dsl({"size": 999, "from": 999}, size=10, from_=0)
    assert resolved_size == 10
    assert resolved_from == 0


def test_dsl_falls_back_to_body_fields() -> None:
    resolved_size, resolved_from = _validate_dsl({"size": 5, "from": 7}, None, None)
    assert resolved_size == 5
    assert resolved_from == 7


def test_dsl_valid_no_overrides() -> None:
    resolved_size, resolved_from = _validate_dsl({"query": {"match_all": {}}}, None, None)
    assert resolved_size is None
    assert resolved_from is None
