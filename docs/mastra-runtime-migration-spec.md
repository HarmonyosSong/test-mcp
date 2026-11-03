# Mastra Runtime Migration Specification

Status: approved for implementation by the repository owner on 2026-11-03.

## 1. Objective

Replace the current Python PydanticAI and FastAPI application runtime with a TypeScript Mastra runtime across the complete user-facing request path. Preserve the existing product behavior and user data while moving agent execution, API orchestration, model access, conversation recovery, runtime validation, and runtime evaluation to the Mastra application.

The migration is complete only when the web application uses the Mastra-backed service, all required production and development workflows pass, existing supported data is migrated or explicitly preserved, and the retired PydanticAI/FastAPI runtime is no longer required to start or operate the product.

## 2. Product and system boundary

The product remains a read-only HarmonyOS troubleshooting workbench:

```text
React workbench
  -> Mastra TypeScript application and custom API routes
      -> Mastra diagnosis agent, stateful conversation, stream adapter
      -> Python repository-inspection MCP service
      -> Python knowledge MCP service
      -> optional external development-knowledge MCP service
      -> configured model provider
```

### In scope for replacement

- `agent/` PydanticAI execution runtime, dependency and provider gateway, Python runtime event mapping, Python diagnosis evaluation runner, and their runtime-only tests.
- `server/` FastAPI application, routes, dependency container, SSE/AG-UI stream conversion, runtime lifecycle and Python server tests.
- Python conversation message state and evidence state persistence contracts where they are coupled to PydanticAI message types.
- Root setup, development, test, build, lint, and deployment commands that currently require the Python Agent or FastAPI packages.
- Runtime documentation, architecture documentation, and README technology/startup instructions.

### Retained as independent domain services

- `mcp_server/` Python FastMCP repository inspection and knowledge retrieval services. They are domain capabilities accessed through MCP, not the application Agent runtime.
- `knowledge/`, `skills/`, diagnostic datasets, product behavior, and the React/Vite user interface. Skills remain file-based Markdown with the existing metadata and applicability rules.
- Existing Git snapshot semantics and read-only inspection boundaries. Their implementation may move from Python into TypeScript where needed to remove the old application service, but observable behavior and security constraints must remain equivalent.

No business-repository write, shell execution, build, device, emulator, or DevEco operation is introduced by this migration.

## 3. Target runtime design

### 3.1 Application composition

- Add a dedicated TypeScript application package for Mastra runtime, custom HTTP routes, runtime/domain services, and runtime tests. Keep it separate from the Vite web package.
- Set the minimum runtime to Node.js `22.13.0`, required by the currently resolved Mastra core package. Pin exact Mastra package versions in the lockfile. Phase 1 lockfile currently verifies `@mastra/core@1.81.0`, `@mastra/hono@1.7.21`, `@mastra/libsql@1.28.0`, `@mastra/mcp@2.7.0`, Hono `4.13.16`, and Zod `4.6.7`; Node is tested with `22.22.0`. Recheck the supported package set before adding Mastra Memory because the product database remains authoritative for case state.
- Mastra is the only Agent orchestration framework in the product. Do not run PydanticAI and Mastra as competing production paths or leave a feature flag that selects the old runtime after cutover.
- Use Mastra custom API routes or a documented Mastra server adapter to implement the existing product API. The Mastra server listens on port `8000` by default to preserve local proxy and deployment conventions; the Vite development server remains on `5174`.
- A production start command serves the built React assets and API from the Mastra application. A development mode runs Mastra and Vite separately, matching the current two-terminal workflow.
- Keep the API boundary independent of Mastra internal types. HTTP DTOs, persisted product records, and AG-UI event payloads use explicit Zod schemas and stable product-owned types.

### 3.2 Agent and diagnosis flow

- Implement one primary diagnosis Agent with the current Chinese/English behavior, entry routing rules, Skill catalog, evidence policy, structured diagnosis output, and user-facing tone.
- Continue supporting free-form multi-turn diagnosis. A user message may lead to a dynamic tool sequence; the runtime must not force every diagnosis into a fixed checklist.
- Model expected diagnostic phases as observable run metadata (intake, investigation, evidence review, report/follow-up) where reliable. These labels must not imply a phase has completed unless the corresponding event or result confirms it.
- Submit the final structured report through a runtime-controlled validation boundary. The model may propose a report, but only validated reports may be persisted as successful diagnosis results.
- Every positive root-cause candidate must reference real observations recorded by runtime-owned evidence state. The model cannot provide or override evidence kind, source, or location.
- A positive candidate must cite at least one source-code or log observation. A user statement may establish the reported symptom but cannot alone establish a technical root cause. Business context and retrieved knowledge are guidance, never incident evidence.

### 3.3 State and persistence

- Use a persistent Mastra-supported storage adapter suitable for a single-node local deployment and restart recovery. The default local installation must not require an externally managed database. Select and document the exact adapter and schema before its implementation stage.
- Keep product conversation metadata separate from Mastra's internal message representation. Product records include conversation identity/title, model override, repository snapshot identity, user-visible messages, tool-step summaries, reports, token/tool metrics, statuses, timestamps, and evidence state.
- Define the app-owned product database as the source of truth for conversation records, reports, repository bindings, tool-step summaries, metrics, and evidence snapshots. Mastra storage may own internal workflow/run checkpoints and model memory, but it must not become a second conflicting source for user-visible conversation state. Every duplicated message/run write needs a stable idempotency key and startup reconciliation rule.
- Mastra thread/resource IDs are deterministically mapped from product conversation IDs. Do not expose internal Mastra IDs as the only product identifiers.
- Persist user input before starting a run. Persist tool-step transitions and evidence updates as they occur or through an equivalent recoverable event journal. Persist a terminal completed/failed/cancelled state before ending the response stream.
- On restart, reconcile any run left in `streaming` into a truthful interrupted state; preserve the user's prompt and completed tool observations, discard partial assistant conclusions and incomplete tool calls from reusable model context, and permit a follow-up turn.
- A run aborted by client disconnect, timeout, application shutdown, or cancellation must close upstream model/MCP work where supported and must not leave the conversation permanently locked.
- Define and test an idempotent migration from existing `.data/conversations.json`, `.data/repositories.json`, model configuration, and repository registry/snapshot metadata. Preserve conversation IDs, messages, reports, model overrides, repository refs/commit IDs, evidence state, provider/base URL/compatibility settings, locally configured credentials, and timestamps. Old PydanticAI message arrays are not passed to Mastra as native history; reconstruct safe user/assistant text history from product messages, omit unfinished calls and untrusted partial answers, and retain old display records.
- Migration must be repeatable, create a backup before modifying source data, record a schema version, and never delete the source JSON automatically. Provide a dry-run/report mode and a documented rollback procedure.

### 3.4 Streaming and web contract

- Preserve the frontend's current `POST /api/conversations/{id}/messages` request shape and AG-UI/SSE event semantics: `RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, tool start/end, state snapshot, run finished, and run error.
- Translate Mastra stream chunks in one server-side adapter. Do not expose raw Mastra chunks as a new frontend contract.
- Preserve stable message IDs and conversation state in stream snapshots, including disconnect and error terminal state.
- Keep keepalive behavior, no-cache/no-buffer headers, backpressure, and cancellation handling. Validate proxy and production static-serving modes.
- Preserve all existing REST paths, status codes, request/response fields, and redaction behavior unless an incompatibility is explicitly documented and the frontend is migrated in the same stage.

### 3.5 Model configuration

- Preserve provider presets, runtime model configuration in the settings UI, per-conversation model override, model connection test, model discovery, disable-model behavior, and secret redaction.
- Preserve configuration precedence: explicit runtime settings override environment defaults; model overrides apply only to the selected conversation; disabling runtime configuration returns chat to the unconfigured state. Preserve support for no-key local endpoints where applicable.
- Preserve OpenAI, DeepSeek, Qwen, Moonshot/Kimi, GLM, Volcano/Doubao and arbitrary OpenAI-compatible endpoints where the provider API supports them. Compatibility mode behavior must remain covered.
- Preserve existing local credential behavior: a model configured in the settings UI survives restart in the owner-only (`0600`) `.data/model-config.json`; environment configuration takes precedence. Do not copy the key into the product database, reports, migration reports, logs, status, stream events, errors, or evaluation artifacts. The Mastra runtime reads this same local file until a separately reviewed encrypted-secret-store design is adopted; this preserves current local-product behavior without representing filesystem-at-rest protection as encryption.
- Provider/model selection must be implemented through supported Mastra/model-provider APIs. Any provider that requires a custom AI SDK adapter must have an explicit test and user-visible compatibility result.
- Update model context-window and price metadata consistently with the UI behavior; unknown values remain unknown instead of fabricated.

### 3.6 MCP and capability wiring

- Connect the repository and knowledge MCP services through Mastra's documented MCP client/connection API. Keep tool names, argument/return JSON contracts, pagination, timeout handling, error distinction, and read-only guarantees stable.
- Bind each repository-tool context to the conversation's immutable resolved commit. Concurrent conversations may use different snapshots; a long-lived MCP connection must never silently move a conversation to a newer branch head.
- Preserve repository URL validation, branch validation, allowed local-root checks, symlink escape rejection, Git timeout behavior, duplicate registration handling, and stable snapshot reuse. No Git operation may mutate a user's working tree.
- Optional external development knowledge remains absent from the agent when unconfigured. When configured, retain coverage gating, verbatim symptom handling, response-size limits, schema validation, source classification, and failure fallback.
- Load only Skills applicable to the active chat and available tool set. Keep the Markdown skill sources authoritative; do not silently duplicate their instructions into runtime-only constants.
- The evidence ledger, failure/call/no-progress budgets, repeated-success cache, locator hints, and report validator are product policies, not assumptions about Mastra defaults. Implement them as explicit Mastra middleware/tool wrappers or application services and test their boundaries.
- Preserve the evidence ledger lifecycle: content-stable IDs, cross-turn persistence, protected current-turn observations, historical soft-cap eviction, bounded current-turn hard limits, eviction tombstones distinguishing expired from unknown IDs, and restoration of an evicted ID after rereading identical content. Cache reuse must return still-valid evidence references.
- Preserve query-log correlation fields (conversation/message IDs, retrieval version, status, latency, verdict/outcome) and end-of-turn diagnosis-case capture. Capture failure remains non-fatal and must not change the diagnosis terminal status.
- Tool usage accounting distinguishes attempted, accepted, blocked, pending, evidence-expired, model requests, and elapsed time. A framework-level rejected/invalid tool call that never entered the budget is counted once as blocked; budget-level rejection is not counted again. Concurrent tool calls share one atomic run budget.

### 3.7 Evaluation and observability

- Keep existing JSONL datasets and expected diagnosis/knowledge behavior. Migrate runtime-driven test harnesses to TypeScript without weakening case assertions or reducing scenario coverage.
- Preserve offline deterministic tests for tool call behavior, evidence validation, failure budgets, history compaction, report schema, provider selection, conversation migration, stream events, and interruption recovery.
- Preserve deterministic assertions for query-log version/status and diagnosis-case capture, including best-effort archive failure behavior.
- Keep live evaluation opt-in and fail clearly when required provider credentials are absent. Compare before/after results on the same model and dataset; archive the baseline and candidate outputs without committing secrets or generated large reports.
- Add runtime observability for run ID, conversation ID, model/provider, model request count, token usage, elapsed time, tool usage, failure category, and evidence expiry. Redact secrets and avoid logging full source files, logs, user API keys, or unrestricted prompts by default.

## 4. Compatibility invariants

The following are release-blocking invariants:

1. Existing API consumers and the current React client continue to work after the runtime cutover.
2. Conversations, reports, repository bindings, model overrides, and usable evidence survive migration and process restart.
3. A model cannot forge evidence IDs, excerpts, source, location, or positive diagnosis support.
4. Knowledge and external documentation remain diagnostic leads, not observed incident evidence.
5. Every positive diagnosis candidate is linked to verified evidence; unsupported conclusions remain insufficient or probable only under the existing policy.
6. Tool budgets count attempted, accepted, blocked, and pending calls without double counting; no-progress loops stop and final report submission remains possible under the configured margin.
7. Tool-call/result protocol pairing is preserved in whatever history is sent to the model; interrupted/invalid pairs are not replayed.
8. Repository reads remain confined to allowed roots or immutable commit snapshots; symlink escapes and write operations remain blocked.
9. Client cancellation and server restart result in terminal, recoverable conversation state.
10. Model credentials are never returned or persisted in plaintext.
11. The app remains usable without the optional external knowledge service; configured model failure is explicit and does not silently produce a successful report.
12. Diagnosis-case capture and knowledge query logging retain conversation/message correlation and remain best-effort where currently specified.
13. The production service starts and serves both API and built web UI without the legacy Python Agent/FastAPI runtime.

## 5. API inventory to preserve

The implementation stage must generate or maintain an explicit contract inventory covering:

- `GET /api/health`, `GET /api/meta`.
- Conversation list/create/get/update/delete and message streaming routes.
- Model provider presets, status, configure, test, discover models, and disable routes.
- Repository register/list, branch search, and immutable snapshot routes.
- Existing response DTOs and frontend `types.ts`, including report, evidence, tool-step, token, and status fields.
- Validation errors, 404/409/422/502 behavior, CORS, secret redaction, SSE headers, and keepalive comments.

The current route implementations in `server/src/harmony_server/routes/`, `chat_stream.py`, and `main.py`, plus `web/src/api.ts`, `web/src/agui/events.ts`, and `web/src/types.ts`, are the source of truth for the initial contract baseline.

## 6. Implementation sequence and document updates

No implementation begins until this specification is committed to the worktree and reviewed against the parallel read-only audits.

### Phase 0: Baseline and contract capture

Status: complete.

- Record current test/build/lint results and the API/event/data contracts.
- Capture test counts and key behaviors from existing Python tests and evaluation fixtures.
- Record audited baseline behaviors: persist the streaming placeholder before execution; reject a concurrent turn; on failure/cancel retain the user input but discard partial assistant conclusions and unfinished tool calls; repair stale streaming records at startup; resolve report citations only from observed evidence; share one budget across tools; allow successful read reuse; keep external knowledge optional; make case capture best-effort.
- Update this specification with any discovered requirement before code changes.
- Gate: spec review complete; no unresolved product behavior that prevents architecture choice.

### Phase 1: Mastra application foundation

Status: complete.

- Add TypeScript runtime package, pinned package manager/lockfile, supported Mastra version, server adapter, configuration validation, health endpoint, persistence adapter, and test harness.
- Add architecture note for runtime ownership, storage, thread mapping, and Python MCP connectivity.
- Gate: clean install, typecheck, unit test, health endpoint, persistent restart smoke test.

### Phase 2: Domain contracts and data migration

Status: in progress.

- Port product DTOs/schemas and evidence/report validation to Zod/TypeScript.
- Implement dry-run, backup, idempotent migration and rollback for conversation/repository data.
- Add fixtures representing success, failure, old streaming, old report, multi-turn evidence, and malformed legacy records.
- Gate: migration preserves supported records; second run is a no-op; rollback restores exact source state.

### Phase 3: Capabilities and policy layer

- Connect existing MCP services and optional external knowledge.
- Port repository selection/snapshot service if necessary to remove FastAPI ownership.
- Port Skills, evidence ledger, report submission, locator guidance, runtime budget/cache and metrics.
- Update the specification with actual module locations and any intentional implementation detail changes.
- Gate: each compatibility invariant has a focused test; Python MCP test suite remains green.

### Phase 4: Agent, memory, and streaming

- Implement the Mastra diagnosis Agent, prompt/route behavior, safe history reconstruction/compaction, stream event adapter, cancellation and recovery.
- Keep the frontend contract stable unless a spec amendment documents and tests an intentional protocol change.
- Gate: deterministic end-to-end tests for multi-turn investigation, visible tools, valid/invalid report, cancellation, restart, and follow-up.

### Phase 5: API and frontend integration

- Move all product routes and runtime lifecycle to Mastra; retain endpoint contracts and model settings behavior.
- Switch Vite proxy and production static serving to Mastra.
- Remove imports, dependencies, commands, and deployment requirements for `agent/` and `server/` Python runtime.
- Update README, architecture diagram, `.env.example`, Makefile, and runtime docs in the same stage that changes their truth.
- Gate: complete route contract tests and browser smoke test on desktop and mobile widths; no Python runtime process required.

### Phase 6: Full verification and cutover

- Run migrated TypeScript test suites, all retained Python MCP tests, knowledge validation, lint/typecheck, frontend build, and live evaluation when credentials are configured.
- Run migration against a copy of representative existing user data, start the production command, exercise UI/model setup/repository binding/diagnosis/report/restart/recovery, and inspect logs and stored data for credential leakage.
- Update this specification with final test commands/results and mark every phase complete only with concrete evidence.
- Gate: full suite passes, production server is running and manually exercised, old runtime packages are not needed, docs match actual commands, and rollback assets/procedure exist.

At the end of each phase, update the phase status, actual file paths, tests run, results, and deviations in this document before beginning the next phase. If a test reveals a requirement gap, amend the spec first, then implement the correction.

### Phase status log

| Phase | Status | Evidence |
|---|---|---|
| 0. Baseline and contract capture | Complete | `make test`: 375 passed, 2 skipped; `make build`: passed; `git diff --check`: passed. `make lint` has two pre-existing Ruff import-order failures in `retrieval_v2.py` and `harmony_knowledge_mcp/server.py`; remaining Agent/Server lint checks passed. Two independent read-only audits recorded runtime, API, persistence, deployment, and regression-test contracts. |
| 1. Mastra application foundation | Complete | `runtime/` created with exact npm lockfile; Node 22.22.0 used for clean install; Mastra Hono adapter serves port 8000; `/api/health` and `/api/meta` returned 200; LibSQL thread survived runtime close/recreate; foundation tests, typecheck, and build passed. Dependency versions are recorded in the lockfile. |
| 2. Domain contracts and data migration | Complete | `runtime/src/domain/schemas.ts` defines DTOs and report shape; `runtime/src/migration/legacy.ts` imports 47 conversations, 1 repository, and 6 snapshot metadata records from the current `.data` into an isolated temp DB with 0 rejects. Repeated apply returned `no_op`; rollback on the copy completed with no conflicts; synthetic rollback conflict returned `rollback_partial`; schema version `product-data=1`. Source `.data` was not modified. Model config remains at its owner-only path and is consumed by `ModelConfiguration`. |
| 3. Capabilities and policy layer | In progress | `runtime/src/capabilities/repository.ts`, `runtime/src/capabilities/mcp.ts`, `runtime/src/diagnosis/evidence.ts`, and `runtime/src/diagnosis/skills.ts` are implemented. The runtime now has a 30-call cap with two calls reserved for report submission, a 10-failure cap, a pure-read successful-result cache that checks evidence expiry, and bounded repeated-cache handling. Standard and relaxed OpenAI-compatible chat models use Mastra's model interface; relaxed mode disables structured outputs, inlines local `$defs`, merges system messages, and maps `max_completion_tokens` to `max_tokens`. Remaining parity includes transient-only identical retry, empty/duplicate/search-result no-progress detection, cache invalidation on repository snapshot changes, concurrency serialization, query-log correlation, diagnosis-case archive, and locator guidance. |
| 4. Agent, memory, and streaming | In progress | `runtime/src/diagnosis/agent.ts` and `runtime/src/http/conversations.ts` use Mastra Agent, safe product history, evidence capture, tool-error/abort handling, and single terminal SSE events. Runtime tests cover route completion and budget boundaries. Provider-backed diagnosis, full tool-pair protocol coverage, cancellation/restart, and follow-up regression cases remain. |
| 5. API and frontend integration | In progress | `runtime/src/app.ts` mounts conversation/model/repository routes and can serve `web/dist`; `Makefile`, `README.md`, `.env.example`, and `docs/ARCHITECTURE.md` describe Mastra startup. Runtime has 55 passing tests after policy/provider additions; the web production build passes. Browser desktop/mobile flow, complete status-code matrix, and removal/migration of legacy evaluation commands remain. |
| 6. Full verification and cutover | In progress | Node 22 runtime typecheck, 55 runtime tests, runtime/web builds, 165 Python MCP tests, knowledge validation, lint, production smoke (`/api/health`, `/api/meta`, `/`, static JS, conversation creation), and `git diff --check` pass. Browser/provider-backed diagnosis, Python MCP live stdio through the runtime, remaining policy parity, and legacy-runtime retirement remain outstanding. |

### Current implementation paths

- Product runtime entry: `runtime/src/server.ts`; application assembly: `runtime/src/app.ts`.
- Mastra model stream adapter: `runtime/src/diagnosis/agent.ts`.
- Stable frontend SSE adapter: `runtime/src/http/conversations.ts`.
- LibSQL product repository: `runtime/src/product/store.ts`.
- Legacy import/rollback: `runtime/src/migration/legacy.ts` and `runtime/src/migration/cli.ts`.
- MCP connections: `runtime/src/capabilities/mcp.ts`; repository snapshots: `runtime/src/capabilities/repository.ts`.

## 7. Acceptance and release criteria

The migration is accepted only when all of the following are true:

- Every phase above is marked complete with test evidence and no unresolved deviation.
- TypeScript/Mastra is the sole application Agent and HTTP runtime.
- Existing feature-level regression cases pass with no reduction in assertions or required scenario coverage.
- Knowledge retrieval and all Python MCP tests pass unchanged or with narrowly justified protocol updates.
- Existing user data migration and rollback have been exercised on a representative copy.
- Development and production startup instructions are tested from a clean install.
- Production mode serves the actual built React application and APIs from the Mastra process.
- Browser-driven happy-path and failure/recovery flows pass against the running service.
- No stale README/docs/configuration claims PydanticAI or FastAPI is required for the product runtime.
- The final diff contains no accidentally included secrets, generated result dumps, or unrelated user changes.

## 8. Risks and required decisions

- **Mastra and provider capabilities change quickly.** Pin exact package versions and verify all APIs against those versions during Phase 1; do not write the implementation against unpinned latest documentation.
- **Provider parity is not guaranteed.** Build a provider matrix from current presets and test each supported provider/config shape before declaring parity.
- **Legacy history is framework-specific.** Never deserialize PydanticAI message JSON into Mastra internals. Reconstruct only safe product-level history and retain original display/report records.
- **Two persistence domains can diverge.** Define the source of truth, event ordering, idempotency key, and startup reconciliation before Phase 1 storage code. Do not claim durability based only on Mastra memory persistence.
- **Replacing FastAPI expands migration scope.** Route status codes, streaming cancellation, startup/shutdown behavior, static assets, CORS, and error redaction must be explicitly tested.
- **Runtime policy is custom product logic.** Framework defaults do not satisfy evidence provenance, failure budgets, immutable snapshots, or report validity.
- **Data cutover can be destructive if attempted in place.** First-run migration must back up, support dry-run, leave source files untouched, and be reversible.

## 9. Documentation and deployment targets

- Root README: Mastra/TypeScript runtime architecture, complete setup, environment configuration, development startup, production build/start, ports, MCP prerequisites, and troubleshooting.
- `docs/ARCHITECTURE.md`: Mastra ownership and service diagram after Phase 5.
- `.env.example`: Mastra runtime settings and existing product settings with secret guidance.
- Makefile/package scripts: clean-install, dev, test, lint, build, migrate, and production start commands.
- Migration operations note: backup, dry-run, apply, verification, rollback, and post-cutover checks.

The word “deployed” for this objective means a reproducible production build is started locally from the documented production command and tested through the served web UI and API. No external hosting account or production environment is specified in the request; publishing to an external environment is not part of this repository-level acceptance.

## 10. Official framework references

Use version-matched official Mastra documentation when implementing; the following references establish the supported capability areas, not an unpinned implementation API contract:

- [Mastra agents and streaming](https://mastra.ai/docs/agents/overview)
- [Mastra MCP connections](https://mastra.ai/docs/connections/mcp)
- [Mastra custom API routes](https://mastra.ai/docs/server/custom-api-routes)
- [Mastra storage](https://mastra.ai/docs/storage)
- [Mastra message history](https://mastra.ai/docs/memory/message-history)
- [Mastra workflow suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)
- [Mastra evaluations](https://mastra.ai/docs/evals/overview)
