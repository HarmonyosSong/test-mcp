# Log catalog

Static routing for optional Aliyun SLS log tools (`resolve_log_target` / `count_cloud_logs` / `search_cloud_logs` / `discover_client_sessions`).

- Edit [`catalog.yaml`](./catalog.yaml) via PR; do not put AppID/AppSecret here.
- Runtime loads the file from `HARMONY_AGENT_LOG_CATALOG` or defaults to this path.
- Tools mount only when `HARMONY_AGENT_LOGCENTER_APP_ID` and `HARMONY_AGENT_LOGCENTER_APP_SECRET` are set.
- Extend appids with `identity_fields` and `observation_fields` only after verifying the real field semantics; also declare every identity field used for discovery in `key_fields`. Leave unknown production mappings empty rather than guessing.
- These fields are additive: preserve existing coordinates, aliases, business matches and consumers. Only identity-matched, target-bound entries can confirm an observed platform or enter EvidenceLedger; raw learner identifiers stay in Runtime-private correlation and never belong in this file.
- Spec: [`spec/log-catalog-query-capability.md`](../../../spec/log-catalog-query-capability.md)
