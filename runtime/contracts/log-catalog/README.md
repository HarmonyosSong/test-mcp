# Log catalog

Config-driven routing for optional dual-source log tools (same HTTP APIs as logcenterskill; **business rules live here**, not in code).

- **Aliyun SLS** (`source: aliyun_sls`): resolve `targets[]` by **appid** → join thin `stores[]` for account/collection/topic → `count_cloud_logs` / `search_cloud_logs`
- **未来云 APM** (`source: logcenter`): resolve `targets[]` by aliases → `service_id` → `count_logs` / `query_logs`

## Layout (v3)

| Section | Role |
| --- | --- |
| `defaults` | Shared SLS account/collection/region/time |
| `stores[]` | Physical Logstore only (no business aliases) |
| `targets[]` | First-class resolve units: SLS `appid` (`store_ref`) or APM (`service_id`) |

Resolve prefers business/appid aliases; vague platform words may return `ambiguous`. Query strings prefer each target’s `suggested_query` / `businesses[].match` from this file.

## Tools

`resolve_log_target` · `count_cloud_logs` · `search_cloud_logs` · `count_logs` · `query_logs`

Mount when `HARMONY_AGENT_LOGCENTER_APP_ID` + `SECRET` are set. Path: `HARMONY_AGENT_LOG_CATALOG` or this file.

Spec: [`spec/log-catalog-query-capability.md`](../../../spec/log-catalog-query-capability.md) · APM fields: [`apm-field-notes.md`](./apm-field-notes.md)
