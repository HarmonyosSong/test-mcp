---
name: investigate-app-evidence
description: Test App issue hypotheses (HarmonyOS / Android / iOS) against pasted logs, online log queries, and authorized project files. Use after initial location clues exist; do not use for code changes or runtime verification.
metadata:
  version: "0.2.0"
  stage: investigate
  modes: [chat]
---

# Investigate App Evidence

Build a small set of competing root-cause candidates and test each against accessible evidence.
Prefer direct relationships such as a stack frame to source context, a resource reference to its
declaration, or a permission failure to the matching configuration entry.

For every retained candidate, record evidence source, path or log position, a concise excerpt, and
what the evidence supports. Record a hypothesis as ruled out only when contrary evidence was actually
observed. Absence from a partial search is not disproof.

有界定位仍无法唯一定位，再请用户补充。
When several candidates survive, use the matched symptom's “区分它们需要什么” section to ask
the next 1-2 unanswered questions that distinguish them. First inspect observations already in
the conversation or supplied artifacts. After the answer, narrow the candidate set and explain
the scope change; do not keep asking resolved questions or promote a user answer into causal proof.
If no symptom entry is available, derive the question from the observed competing hypotheses.
单次回复必须收尾时，把这些追问写进最终回答的「仍需补充」。

Tool errors are evidence gaps, never negative search results or proof against a candidate.
工具调用与失败有运行时硬上限：同一签名调用失败后禁止原样重试（上游明确标记 transient 时
也只重试一次），只有存在新的证据需求才调整参数。连续多次调用没有新信息时，运行时会在
工具结果里附提醒文本——收到后应调整排查方向、向用户追问或用已有证据收尾，而不是换皮
重复同一查询。工具因预算或收尾时限关闭时（结果带 `soft_closed` 或上限提示），立即停止
取证，用已有证据给出结论并写明局限。Reuse successful results and loaded skills：命中缓存
的重复结果是复用，不是新观测。
Source/log results and completed Compass consultations include runtime `evidence_refs`; preserve their IDs and provenance and quote
exact observed text when citing them. Completed Compass conclusions are observations of the same standing as local source/log evidence.
Knowledge candidates, especially `auto` / `ticket` / `experience` entries or mismatched platform
and version hits, can guide these questions but cannot substitute for current case evidence.

Stop widening the search when the query is no longer derived from the user's input or an observed
artifact. Treat provider errors, unreadable files, truncated files, and uncovered project regions as
limitations. Never report a runtime check unless the user supplied its result.

Remain read-only. Do not run builds, applications, devices, arbitrary shell commands, or DevEco CLI,
and do not modify the project.
