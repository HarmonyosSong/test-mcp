from ...domain import DiagnosisReport


def diagnosis_summary(report: DiagnosisReport) -> str:
    return f"诊断状态：{report.verdict.value}，总体置信度 {round(report.confidence * 100)}%。"
