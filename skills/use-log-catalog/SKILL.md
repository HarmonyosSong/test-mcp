---
name: use-log-catalog
description: Resolve business log targets from the built-in catalog and query Aliyun SLS via bounded tools. Use when the user asks about remote product/app logs and log tools are available; not a substitute for pasted hilog or source evidence.
metadata:
  version: "0.1.0"
  stage: investigate
  modes: [chat]
  required_tools: [resolve_log_target, count_cloud_logs, search_cloud_logs]
---

# Use Log Catalog

Optional capability for remote Aliyun SLS logs via the built-in catalog. This Skill only appears when
`resolve_log_target`, `count_cloud_logs`, and `search_cloud_logs` are mounted. It does **not** change
the diagnosis evidence ledger in this phase: treat results as investigation helpers, not root-cause
proof. Do not invent account, collection, or topic values outside catalog resolve results.

## When to use

- The user asks about remote product/app logs (口语岛、磨耳朵、装扮商城、Android/iOS 埋点等) and these
  tools are available.
- Prefer local `parse_hilog` when the user already pasted hilog text.
- Do not use catalog tools as a mandatory step in every diagnosis turn.

## Resolve first

1. Call `load_skill("use-log-catalog")` before the first log tool call in a turn that needs remote logs.
2. Call `resolve_log_target` with a short query drawn from the user's wording (business alias, appid, or
   store name). Prefer contiguous user text over paraphrasing.
3. Interpret `status`:
   - `resolved`: use the single candidate's coordinates and `suggested_query`.
   - `ambiguous`: ask one clarifying question that separates candidates; do not search a guess.
   - `not_found`: say the catalog does not cover the request; ask for store/appid or stop. Never scan
     cloud accounts/collections/topics yourself.

## Count then search

4. When volume is uncertain, call `count_cloud_logs` with the resolved `vendor`, `region`, `account`,
   `collection`, `topic`, and `time` (default from conversation or `1h` / `15m`).
5. Call `search_cloud_logs` with the same coordinates. Prefer `suggested_query`; if the user provided
   `uid` / `customtraceid` / other filters, merge them into `query`. Keep `size` small (default ≤ 50).
6. Respect truncated fields. Do not claim ledger evidence or a confirmed root cause from these hits
   alone in this phase.

## Boundaries

- Do not call cloud account/collection/topic listing APIs; expand the catalog instead.
- Do not treat empty search results as proof that an incident did not happen.
- If tools are unconfigured or fail with permission errors, report the gap and continue with other
  available evidence.
