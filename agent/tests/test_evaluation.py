import pytest

from harmony_agent.evaluation import compare, summarize


def test_failed_and_unknown_costs_are_not_zero_and_quality_is_not_inferred():
    rows = [
        {
            "case_id": "a",
            "status": "completed",
            "input_tokens": 10,
            "correct_location": True,
            "unsupported_conclusion": False,
        },
        {"case_id": "b", "status": "failed", "correct_location": False},
    ]
    result = summarize(rows)
    assert result["failed"] == 1
    assert result["correct_location"]["rate"] == 0.5
    assert result["unsupported_conclusion"]["assessed"] == 1
    assert result["appropriate_clarification"]["rate"] is None
    assert result["cost"]["input_tokens"] == {"known_total": 10, "unknown_turns": 1, "total": None}
    run = {"model": "fixed", "dataset_sha256": "same", "rows": rows, "summary": result}
    assert compare(run, run)["cost_delta"]["input_tokens"] is None
    with pytest.raises(ValueError, match="model"):
        compare(run, {**run, "model": "another"})
    with pytest.raises(ValueError, match="相同案例"):
        compare(run, {**run, "rows": rows[:1]})
