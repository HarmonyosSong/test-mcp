from ...domain import DiagnosisCase


def intake_summary(case: DiagnosisCase) -> str:
    materials = ["问题描述"]
    if case.input_evidence:
        materials.append("粘贴证据")
    if case.repository_name and case.requested_ref:
        materials.append(f"仓库 {case.repository_name}/{case.requested_ref}")
    elif case.workspace_path:
        materials.append("授权项目路径")
    return f"已接收{'、'.join(materials)}，输入内容将按不可信数据处理。"
