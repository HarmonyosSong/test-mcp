"""Curated issue-triage knowledge base: loading, validation and read-only retrieval."""

from .loader import KnowledgeBase, KnowledgeValidationError
from .schemas import (
    Authority,
    End,
    KnowledgeDocument,
    KnowledgeEntry,
    KnowledgeKind,
    SearchHit,
    SearchScope,
    SymptomSummary,
)
from .server import KNOWLEDGE_ROOT_ENV, create_knowledge_server, resolve_knowledge_root

__all__ = [
    "KNOWLEDGE_ROOT_ENV",
    "Authority",
    "End",
    "KnowledgeBase",
    "KnowledgeDocument",
    "KnowledgeEntry",
    "KnowledgeKind",
    "KnowledgeValidationError",
    "SearchHit",
    "SearchScope",
    "SymptomSummary",
    "create_knowledge_server",
    "resolve_knowledge_root",
]
