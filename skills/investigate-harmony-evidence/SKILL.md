---
name: investigate-harmony-evidence
description: Test HarmonyOS issue hypotheses against pasted logs and authorized project files. Use after initial location clues exist; do not use for code changes or runtime verification.
metadata:
  version: "0.1.0"
  stage: investigate
---

# Investigate Harmony Evidence

Build a small set of competing root-cause candidates and test each against accessible evidence.
Prefer direct relationships such as a stack frame to source context, a resource reference to its
declaration, or a permission failure to the matching configuration entry.

For every retained candidate, record evidence source, path or log position, a concise excerpt, and
what the evidence supports. Record a hypothesis as ruled out only when contrary evidence was actually
observed. Absence from a partial search is not disproof.

Stop widening the search when the query is no longer derived from the user's input or an observed
artifact. Treat provider errors, unreadable files, truncated files, and uncovered project regions as
limitations. Never report a runtime check unless the user supplied its result.

Remain read-only. Do not run builds, applications, devices, arbitrary shell commands, or DevEco CLI,
and do not modify the project.
