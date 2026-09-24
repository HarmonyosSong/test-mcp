---
name: report-harmony-diagnosis
description: Produce a structured, evidence-linked HarmonyOS report via submit_diagnosis_report once evidence supports a conclusion or the user asks for one. Not for fixes or runtime validation.
metadata:
  version: "0.3.0"
  stage: diagnose
  modes: [chat]
  required_tools: [submit_diagnosis_report]
---

# Report Harmony Diagnosis

Submit exactly one `DiagnosisReport` through the `submit_diagnosis_report` tool; do not paste
report drafts into the chat text. Choose exactly one verdict:

- `located` only when accessible evidence directly identifies the causal location and behavior.
- `probable` when one candidate is better supported than alternatives but still needs verification.
- `insufficient_evidence` when the current material cannot support a reliable candidate.
- `tool_error` when a failed inspection materially prevents completion.

Every `located` or `probable` candidate must reference at least one evidence ID included in the same
report. Calibrate confidence to evidence quality, not answer fluency. State the likely location only
when a path, symbol, module, or configuration area was observed.
Use only IDs from precollected evidence or tool `evidence_refs`. Copy kind, source and location
exactly, and quote an exact observed excerpt. The submission tool rejects unobserved or altered
evidence; fix the report and resubmit when validation fails. Evidence observed in earlier turns of
this conversation remains citable.
Every positive candidate needs observed source or log evidence; knowledge and repository context
alone cannot establish the current cause. This structural check does not prove the causal argument.

有界定位仍无法唯一定位，再请用户补充。
If the entry route, environment, or competing causal branches remain unresolved, return
`insufficient_evidence` and put the next discriminating questions in `missing_information`.
Choose them from the matched symptom's “区分它们需要什么” section when available; reuse all
previous answers and available URL/log observations. Do not treat narrowing as root-cause confirmation.
Disclose failed or budget-blocked tool calls as limitations. An isolated tool failure does not
invalidate independent evidence; choose `tool_error` only when it materially prevents completion.
Knowledge search matches and symptom candidate lists alone do not support a positive verdict.

Include the conclusion, category, severity, candidates, evidence chain, checks performed, ruled-out
hypotheses, missing information, confidence, and limitations. Recommendations in this MVP are limited
to evidence the user can collect or verify; do not provide a patch or claim the issue is resolved.

Always disclose that the diagnosis was static and read-only, that no build or device verification was
performed, that DevEco CLI was not called, and that no project file was modified.
