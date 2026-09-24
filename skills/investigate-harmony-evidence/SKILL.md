---
name: investigate-harmony-evidence
description: Test HarmonyOS issue hypotheses against pasted logs and authorized project files. Use after initial location clues exist; do not use for code changes or runtime verification.
metadata:
  version: "0.2.0"
  stage: investigate
  modes: [chat]
---

# Investigate Harmony Evidence

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
In single-shot reports, record the discriminating questions in `missing_information`.

Tool errors are evidence gaps, never negative search results or proof against a candidate. Respect
the shared per-turn failure budget (default 10). Do not repeat a failed call with identical
arguments unless the upstream explicitly marks it transient; even then retry only once. Change
parameters only for a new evidence-backed lookup. When the budget is exhausted, stop using tools
and report the evidence, limitations, and minimum unanswered question.
The runtime also caps total calls and consecutive calls without new information. Reuse successful
results and loaded skills; `reused_from_call` points to an existing result, not a fresh observation.
When a budget removes tools, conclude with supported findings and missing evidence. Do not evade it
by changing parameters without an evidence need. Source/log results include runtime `evidence_refs`;
preserve their IDs and provenance and quote exact observed text when citing them.
Knowledge candidates, especially `auto` / `ticket` / `experience` entries or mismatched platform
and version hits, can guide these questions but cannot substitute for current case evidence.

Stop widening the search when the query is no longer derived from the user's input or an observed
artifact. Treat provider errors, unreadable files, truncated files, and uncovered project regions as
limitations. Never report a runtime check unless the user supplied its result.

Remain read-only. Do not run builds, applications, devices, arbitrary shell commands, or DevEco CLI,
and do not modify the project.
