---
name: report-harmony-diagnosis
description: Produce a structured, evidence-linked HarmonyOS diagnosis report after investigation. Use for diagnosis conclusions only, not fixes, patches, or claims of runtime validation.
metadata:
  version: "0.1.0"
  stage: diagnose
---

# Report Harmony Diagnosis

Choose exactly one verdict:

- `located` only when accessible evidence directly identifies the causal location and behavior.
- `probable` when one candidate is better supported than alternatives but still needs verification.
- `insufficient_evidence` when the current material cannot support a reliable candidate.
- `tool_error` when a failed inspection materially prevents completion.

Every `located` or `probable` candidate must reference at least one evidence ID included in the same
report. Calibrate confidence to evidence quality, not answer fluency. State the likely location only
when a path, symbol, module, or configuration area was observed.

Include the conclusion, category, severity, candidates, evidence chain, checks performed, ruled-out
hypotheses, missing information, confidence, and limitations. Recommendations in this MVP are limited
to evidence the user can collect or verify; do not provide a patch or claim the issue is resolved.

Always disclose that the diagnosis was static and read-only, that no build or device verification was
performed, that DevEco CLI was not called, and that no project file was modified.
