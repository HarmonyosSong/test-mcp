from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import yaml

from .schemas import Authority, End, KnowledgeEntry, KnowledgeKind

FRONTMATTER_OPEN = "---\n"
REFERENCE_PATTERN = re.compile(r"\[\[([^\]\r\n]+)\]\]")
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")

SYMPTOM_DIR = "symptoms"
FACT_DIR = "facts"

FACT_KINDS = frozenset(
    {KnowledgeKind.PLATFORM_FACT, KnowledgeKind.MAPPING, KnowledgeKind.EXPERIENCE}
)

DEFAULT_STALE_DAYS = 180

# 这些等级会被称为正向结论的证据，因此必须有人核对过；缺 verified_at 时告警。
EVIDENCE_AUTHORITIES = frozenset({Authority.OFFICIAL, Authority.INTERNAL_SOP, Authority.CODE})


class KnowledgeValidationError(ValueError):
    """知识库无法加载时抛出，错误信息包含全部问题。"""


class KnowledgeBase:
    """从内容仓库加载现象条目与事实条目。

    这个类同时承担 CI 校验的职责：`load()` 遇到任何格式或引用问题都会失败，
    因为一条引用断掉会让一次排查静默降级，而这正是知识库最常见的腐烂方式。
    """

    def __init__(self, root: Path, *, stale_days: int = DEFAULT_STALE_DAYS) -> None:
        self.root = Path(root).expanduser()
        self.stale_days = stale_days
        self.warnings: list[str] = []
        self._entries: dict[str, KnowledgeEntry] = {}

    def load(self) -> list[KnowledgeEntry]:
        entries, errors, warnings = self._scan()
        if errors:
            raise KnowledgeValidationError("\n".join(errors))
        self._entries = {entry.name: entry for entry in entries}
        self.warnings = warnings
        return self.all()

    def validate(self) -> tuple[list[str], list[str]]:
        """返回 (错误, 警告)，不抛异常，供 CI 与命令行使用。"""
        _, errors, warnings = self._scan()
        return errors, warnings

    def all(self) -> list[KnowledgeEntry]:
        return sorted(self._entries.values(), key=lambda entry: (entry.kind.value, entry.name))

    def get(self, name: str) -> KnowledgeEntry | None:
        return self._entries.get(name)

    def symptoms(self) -> list[KnowledgeEntry]:
        return [entry for entry in self.all() if entry.kind is KnowledgeKind.SYMPTOM]

    def _scan(self) -> tuple[list[KnowledgeEntry], list[str], list[str]]:
        errors: list[str] = []
        warnings: list[str] = []
        entries: list[KnowledgeEntry] = []
        if not self.root.is_dir():
            return [], [f"知识库根目录不存在或不是目录：{self.root}"], []

        for directory, allowed in (
            (SYMPTOM_DIR, frozenset({KnowledgeKind.SYMPTOM})),
            (FACT_DIR, FACT_KINDS),
        ):
            folder = self.root / directory
            if not folder.is_dir():
                errors.append(f"缺少目录：{directory}/")
                continue
            paths = sorted(folder.rglob("*.md"))
            if not paths:
                warnings.append(f"{directory}/ 下没有任何条目")
            for path in paths:
                parts = path.relative_to(folder).parts
                if directory == FACT_DIR and (
                    len(parts) != 2 or not NAME_PATTERN.fullmatch(parts[0])
                ):
                    errors.append(
                        f"{path.relative_to(self.root)}: 事实必须位于 facts/<业务域>/<name>.md，"
                        "业务域使用 kebab-case，禁止平铺或继续嵌套"
                    )
                    continue
                if directory == SYMPTOM_DIR and len(parts) != 1:
                    errors.append(f"{path.relative_to(self.root)}: 现象必须位于 symptoms/<name>.md")
                    continue
                entry = self._read_entry(path, directory, allowed, errors)
                if entry is not None:
                    entries.append(entry)

        known: dict[str, KnowledgeEntry] = {}
        for entry in entries:
            previous = known.get(entry.name)
            if previous is not None:
                errors.append(
                    f"条目名重复：{entry.name}（{previous.source_path} 与 {entry.source_path}）"
                )
                continue
            known[entry.name] = entry
        for entry in known.values():
            for reference in entry.references:
                if reference not in known:
                    errors.append(f"{entry.source_path}: 引用 [[{reference}]] 无法解析")
                elif known[reference].kind is KnowledgeKind.SYMPTOM:
                    errors.append(
                        f"{entry.source_path}: 引用只能指向事实条目，"
                        f"不能指向现象（[[{reference}]]）"
                    )
            _warn_if_stale(entry, self.stale_days, warnings)
            _warn_if_unverified(entry, warnings)
        return list(known.values()), errors, warnings

    def _read_entry(
        self,
        path: Path,
        directory: str,
        allowed: frozenset[KnowledgeKind],
        errors: list[str],
    ) -> KnowledgeEntry | None:
        relative = path.relative_to(self.root).as_posix()
        text = path.read_text(encoding="utf-8")
        if not text.startswith(FRONTMATTER_OPEN):
            errors.append(f"{relative}: 缺少 YAML frontmatter")
            return None
        parts = text.split("---", 2)
        if len(parts) < 3:
            errors.append(f"{relative}: frontmatter 未闭合")
            return None
        try:
            metadata = yaml.safe_load(parts[1]) or {}
        except yaml.YAMLError as exc:
            errors.append(f"{relative}: frontmatter 不是合法 YAML（{exc}）")
            return None
        if not isinstance(metadata, dict):
            errors.append(f"{relative}: frontmatter 必须是键值对")
            return None

        body = parts[2].strip()
        problems = _field_problems(path, metadata, allowed)
        domains = metadata.get("domains", [path.parent.name] if directory == FACT_DIR else [])
        if not isinstance(domains, list) or any(
            not isinstance(domain, str) or not NAME_PATTERN.fullmatch(domain) for domain in domains
        ):
            problems.append("domains 必须是 kebab-case 业务域列表")
        elif len(set(domains)) != len(domains):
            problems.append("domains 不得重复")
        elif directory == FACT_DIR and path.parent.name not in domains:
            problems.append(f"domains 必须包含所在业务域 {path.parent.name}")
        if problems:
            errors.extend(f"{relative}: {problem}" for problem in problems)
            return None

        kind = KnowledgeKind(str(metadata["kind"]).strip())
        symptom = str(metadata.get("symptom", "")).strip()
        description = str(metadata.get("description", "")).strip()
        return KnowledgeEntry(
            name=str(metadata["name"]).strip(),
            kind=kind,
            title=_markdown_title(body, str(metadata["name"]).strip()),
            summary=symptom or description,
            body=body,
            applies_to=[End(str(item).strip()) for item in metadata["applies_to"]],
            authority=Authority(str(metadata["authority"]).strip()),
            domains=domains,
            aliases=[
                str(item).strip() for item in metadata.get("aliases") or [] if str(item).strip()
            ],
            applicable_versions=_optional_text(metadata.get("applicable_versions")),
            updated_at=metadata.get("updated_at"),
            verified_at=metadata.get("verified_at"),
            references=sorted(set(REFERENCE_PATTERN.findall(body))),
            source_path=relative,
        )


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _markdown_title(body: str, fallback: str) -> str:
    for line in body.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def _field_problems(
    path: Path,
    metadata: dict,
    allowed: frozenset[KnowledgeKind],
) -> list[str]:
    problems: list[str] = []

    name = str(metadata.get("name", "")).strip()
    if not name:
        problems.append("缺少 name")
    elif not NAME_PATTERN.match(name):
        problems.append(f"name 必须是 kebab-case：{name}")
    elif name != path.stem:
        problems.append(f"name（{name}）必须与文件名（{path.stem}）一致")

    raw_kind = str(metadata.get("kind", "")).strip()
    kind: KnowledgeKind | None = None
    if not raw_kind:
        problems.append("缺少 kind")
    else:
        try:
            kind = KnowledgeKind(raw_kind)
        except ValueError:
            problems.append(f"kind 取值非法：{raw_kind}")
        else:
            if kind not in allowed:
                allowed_text = " / ".join(sorted(item.value for item in allowed))
                problems.append(
                    f"{path.parent.name}/ 下只允许 kind = {allowed_text}，收到 {raw_kind}"
                )

    applies_to = metadata.get("applies_to")
    if not isinstance(applies_to, list) or not applies_to:
        problems.append("applies_to 必须是非空列表")
    else:
        for item in applies_to:
            try:
                End(str(item).strip())
            except ValueError:
                problems.append(f"applies_to 取值非法：{item}")

    raw_authority = str(metadata.get("authority", "")).strip()
    if not raw_authority:
        problems.append("缺少 authority")
    else:
        try:
            Authority(raw_authority)
        except ValueError:
            problems.append(f"authority 取值非法：{raw_authority}")

    updated_at = metadata.get("updated_at")
    if updated_at is None:
        problems.append("缺少 updated_at")
    elif not isinstance(updated_at, date):
        problems.append(f"updated_at 必须是 YYYY-MM-DD 日期，收到：{updated_at!r}")

    # verified_at 可以缺席。缺席即“从未人工验证”，条目仍可入库，但不会被当成正向证据；
    # 让它可选是为了不必为了填表而伪造一个验证日期。
    verified_at = metadata.get("verified_at")
    if verified_at is not None and not isinstance(verified_at, date):
        problems.append(f"verified_at 必须是 YYYY-MM-DD 日期，收到：{verified_at!r}")

    if kind is KnowledgeKind.SYMPTOM:
        if not str(metadata.get("symptom", "")).strip():
            problems.append("现象条目必须提供 symptom")
    elif kind is not None and not str(metadata.get("description", "")).strip():
        problems.append("事实条目必须提供 description")

    aliases = metadata.get("aliases")
    if aliases is not None and not isinstance(aliases, list):
        problems.append("aliases 必须是列表")

    return problems


def _warn_if_stale(entry: KnowledgeEntry, stale_days: int, warnings: list[str]) -> None:
    if entry.verified_at is None:
        return
    age = (date.today() - entry.verified_at).days
    if age > stale_days:
        warnings.append(f"{entry.source_path}: 已有 {age} 天未人工验证，可能过期")


def _warn_if_unverified(entry: KnowledgeEntry, warnings: list[str]) -> None:
    """高可信等级却没有验证日期，说明有人把结论写得比证据更硬。"""
    if entry.verified_at is None and entry.authority in EVIDENCE_AUTHORITIES:
        warnings.append(
            f"{entry.source_path}: authority 是 {entry.authority.value} 但从未人工验证，"
            "不能作为正向结论的证据"
        )
