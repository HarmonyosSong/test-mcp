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
Evidence is cited by reference: each item takes only `id` (a tool `evidence_refs` ID, or an
`ev-user-*` ID from the `user_evidence` list in the instructions state block), `excerpt` (a verbatim
substring of that observation or user message), and `supports`. Never fill in kind, source, or
location — the system assembles them from the ledger. The submission tool rejects unknown, expired,
or misquoted citations with an error code; fix and resubmit. Evidence observed in earlier turns of
this conversation remains citable.
Every root-cause candidate, regardless of verdict, must cite at least one observed source or log
item in the same report. User descriptions, knowledge, and repository context cannot serve as the
candidate's only evidence. This structural check does not prove the causal argument.
When returning `insufficient_evidence` because no source or log observation supports a cause, leave
`root_cause_candidates` empty. Keep architecture or ownership details from knowledge explicitly
labeled as knowledge leads in the summary or limitations; do not turn them into incident candidates.
For an `insufficient_evidence` report, set `likely_location` to null unless the current user-provided
stack/log or a completed source/log tool observation identifies a concrete location. Never put an
undifferentiated list of possible components in `likely_location`; retain it as a labeled lead in
the summary only when it helps choose the next question.

Separate conditional code behavior from the observed incident. Source such as `value!.method()` can
prove that the expression throws if `value` is nullish; it does not prove the current caller passed a
nullish value. If a user supplies a stack frame, cite it as user-provided runtime evidence and limit
the claim to what that frame plus inspected source supports. Keep missing call arguments, environment,
and causal links in `missing_information` unless they were actually observed.
For example, when a stack points to `profile.name!.trim()` but the argument was not observed, report
that the failing frame is consistent with a missing `name` and explicitly say the actual argument is
unknown. Do not write “the caller passed no name” as an incident fact or in a confirmed candidate.
If the stack and source identify the failing line but the triggering argument/state was not observed,
the verdict may be at most `probable`; phrase the candidate conditionally and keep the unobserved state
in `missing_information`. Use `located` only when the observed evidence establishes the causal behavior
for this incident, not merely a code path that would fail under one possible input.

Describe checks exactly as performed. Do not claim a repository or specific files were checked unless
the corresponding read/search tool completed, and do not claim coverage broader than the returned
observations (for example, one file scan is not proof that the deployed call path was checked).

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
