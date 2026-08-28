def investigation_summary(evidence_count: int, workspace_checks: list[str]) -> str:
    suffix = f"，执行 {len(workspace_checks)} 项只读项目检索" if workspace_checks else ""
    return f"已校验 {evidence_count} 条证据与候选原因的关联{suffix}。"
