import json
from pathlib import Path

import pytest

from harmony_agent.domain import ChatMessage, Conversation, DiagnosisReport
from harmony_agent.knowledge_feedback import capture, draft_case, link_entry, review_case

ROOT = Path(__file__).resolve().parents[2] / "knowledge"


def test_review_draft_and_link_preserve_archive_and_canonical_id(tmp_path):
    report = DiagnosisReport.model_validate(
        {
            "verdict": "probable",
            "summary": "入口问题",
            "issue_category": "entry",
            "confidence": 0.6,
            "evidence": [
                {
                    "id": "ev-source",
                    "kind": "source",
                    "source": "Entry.ets",
                    "excerpt": "observed",
                    "supports": "入口",
                    "location": "1",
                }
            ],
            "root_cause_candidates": [
                {
                    "title": "入口",
                    "explanation": "条件",
                    "confidence": 0.6,
                    "evidence_ids": ["ev-source"],
                }
            ],
        }
    )
    message = ChatMessage(role="assistant", report=report)
    conversation = Conversation(
        messages=[ChatMessage(role="user", content="错题本进不去"), message]
    )
    path = capture(conversation, message.id, tmp_path)
    with pytest.raises(ValueError, match="先复核"):
        draft_case(path, ROOT, "error-book-entry-picai-only", "learning")
    with pytest.raises(ValueError, match="证据 ID"):
        review_case(
            path, outcome="confirmed", root_cause="入口", reviewer="test", evidence_ids=["fake"]
        )
    review_case(
        path,
        outcome="confirmed",
        root_cause="核对实际入口条件",
        reviewer="test",
        evidence_ids=["ev-source"],
    )
    assert capture(conversation, message.id, tmp_path) == path
    draft = draft_case(path, ROOT, "error-book-entry-picai-only", "learning")
    assert draft.read_text() == (ROOT / "facts/learning/error-book-entry-picai-only.md").read_text()
    with pytest.raises(ValueError, match="草稿已存在"):
        draft_case(path, ROOT, "error-book-entry-picai-only", "learning")
    with pytest.raises(ValueError, match="规范事实"):
        link_entry(path, ROOT, "nonexistent-entry")
    link_entry(path, ROOT, "error-book-entry-picai-only")
    case = json.loads(path.read_text())
    assert case["review"]["outcome"] == "confirmed"
    assert case["knowledge_entry"] == "error-book-entry-picai-only"
    assert case["proposal"]["existing_entry"] == case["knowledge_entry"]


def test_failed_turn_cannot_be_confirmed_without_observations(tmp_path):
    message = ChatMessage(role="assistant", status="failed", error="network")
    path = capture(Conversation(messages=[message]), message.id, tmp_path)
    with pytest.raises(ValueError, match="实际观测"):
        review_case(path, outcome="confirmed", root_cause="猜测", reviewer="test", evidence_ids=[])
    review_case(
        path, outcome="uncertain", root_cause="无法取得证据", reviewer="test", evidence_ids=[]
    )
    assert json.loads(path.read_text())["review"]["outcome"] == "uncertain"


def test_apply_draft_validates_before_mutation_and_rejects_stale_content(tmp_path):
    import shutil

    from harmony_agent.knowledge_feedback import apply_draft, write_json

    root = tmp_path / "knowledge"
    shutil.copytree(ROOT, root)
    path = tmp_path / "case.json"
    write_json(path, {"input": "错题本进不去", "review": {"outcome": "confirmed"}})
    draft = draft_case(path, root, "error-book-entry-picai-only", "learning")
    original = draft.read_text()
    target = root / "facts/learning/error-book-entry-picai-only.md"
    draft.write_text(original + "\n[[nonexistent-fact]]\n")
    with pytest.raises(ValueError):
        apply_draft(path, root)
    assert target.read_text() == original
    draft.write_text(original + "\n新增案例复核：仍需按当前版本核对入口。\n")
    assert apply_draft(path, root) == target
    assert json.loads(path.read_text())["knowledge_entry"] == "error-book-entry-picai-only"
    with pytest.raises(ValueError, match="已变化"):
        apply_draft(path, root)
