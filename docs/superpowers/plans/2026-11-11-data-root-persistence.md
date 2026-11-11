# Data Root Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `HARMONY_AGENT_DATA_ROOT` so container deploy writes under `/data/troubleshoot-odyssey` while local defaults stay `<projectRoot>/.data`.

**Architecture:** Resolve one data root in `loadRuntimeConfig`; derive mastra/mirrors/workspaces/model-config/query-log/cases (and legacy peers) unless per-path env overrides. Align Dockerfile and `.env-prd` with the mount; no auto migration.

**Tech Stack:** TypeScript runtime config (`runtime/src/config.ts`), node:test, Docker + env templates.

**Spec:** [`spec/data-root-persistence.md`](../../../spec/data-root-persistence.md)

## Global Constraints

- Local unset `HARMONY_AGENT_DATA_ROOT` → `<projectRoot>/.data`
- Container: `HARMONY_AGENT_DATA_ROOT=/data/troubleshoot-odyssey`
- Per-path env overrides beat derived paths
- Must update `.env-prd` and `Dockerfile`; no `VOLUME` in Dockerfile; no data migration

---

### Task 1: Config + tests

- [x] Write failing tests in `runtime/test/data-root-config.test.ts`
- [x] Implement `HARMONY_AGENT_DATA_ROOT` derivation in `runtime/src/config.ts`
- [x] Run `npm --prefix runtime test -- test/data-root-config.test.ts`

### Task 2: Deploy templates

- [x] Update `.env-prd` per spec §4.2
- [x] Update `Dockerfile` per spec §4.3
- [x] Update `.env.example` and `README.md`
- [x] Mark spec status implemented
