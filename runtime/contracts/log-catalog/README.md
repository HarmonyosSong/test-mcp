# Log catalog

Static routing for optional Aliyun SLS log tools (`resolve_log_target` / `count_cloud_logs` / `search_cloud_logs`).

- Edit [`catalog.yaml`](./catalog.yaml) via PR; do not put AppID/AppSecret here.
- Runtime loads the file from `HARMONY_AGENT_LOG_CATALOG` or defaults to this path.
- Tools mount only when `HARMONY_AGENT_LOGCENTER_APP_ID` and `HARMONY_AGENT_LOGCENTER_APP_SECRET` are set.
- Spec: [`spec/log-catalog-query-capability.md`](../../../spec/log-catalog-query-capability.md)
