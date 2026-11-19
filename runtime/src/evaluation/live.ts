import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRuntimeConfig } from '../config.js';
import { createRuntimeApp } from '../app.js';
import { createRoundCapabilitySession } from '../capabilities/session.js';
import { ChatMessageSchema, type ChatMessage } from '../domain/schemas.js';
import { redactRecord } from '../security/redaction.js';
import type { DiagnosisRunInput } from '../diagnosis/agent.js';
import { parseVerdictMarker } from '../diagnosis/final-answer-validator.js';

export interface LiveCase {
  id: string;
  prompts: string[];
  expected: Array<{
    location?: string;
    verdict?: string | string[];
    clarification_terms?: string[];
  }>;
  files?: Record<string, string>;
}

export interface LiveDatasetCase extends LiveCase {
  id: string;
}

const COST_FIELDS = ['input_tokens', 'output_tokens', 'model_requests', 'attempted', 'accepted', 'reused', 'result_chars', 'elapsed_ms'] as const;

export function parseDataset(raw: string): LiveDatasetCase[] {
  const cases: LiveDatasetCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`dataset line ${index + 1} is not valid JSON`);
    }
    if (!item || typeof item !== 'object') throw new Error(`dataset line ${index + 1} must be an object`);
    const value = item as Partial<LiveDatasetCase>;
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id) || ids.has(value.id)) {
      throw new Error(`dataset line ${index + 1} has an invalid or duplicate id`);
    }
    if (!Array.isArray(value.prompts) || value.prompts.length === 0 || value.prompts.some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
      throw new Error(`dataset case ${value.id} must contain non-empty prompts`);
    }
    if (!Array.isArray(value.expected) || value.expected.length !== value.prompts.length || value.expected.some((expected) => !expected || typeof expected !== 'object')) {
      throw new Error(`dataset case ${value.id} must define one expected record per prompt`);
    }
    for (const [turn, expected] of value.expected.entries()) {
      if (expected.location !== undefined && typeof expected.location !== 'string') throw new Error(`dataset case ${value.id} turn ${turn} has invalid location assertion`);
      if (expected.verdict !== undefined) {
        const verdicts = Array.isArray(expected.verdict) ? expected.verdict : [expected.verdict];
        if (!verdicts.length || verdicts.some((verdict) => !['located', 'probable', 'insufficient_evidence', 'tool_error'].includes(verdict))) throw new Error(`dataset case ${value.id} turn ${turn} has invalid verdict assertion`);
      }
      if (expected.clarification_terms !== undefined && (!Array.isArray(expected.clarification_terms) || expected.clarification_terms.some((term) => typeof term !== 'string'))) throw new Error(`dataset case ${value.id} turn ${turn} has invalid clarification terms`);
    }
    if (value.files !== undefined && (!value.files || typeof value.files !== 'object' || Array.isArray(value.files) || Object.values(value.files).some((content) => typeof content !== 'string'))) {
      throw new Error(`dataset case ${value.id} files must map paths to text`);
    }
    for (const name of Object.keys(value.files ?? {})) {
      if (!name.trim() || isAbsolute(name) || name.split(/[\\/]/).some((part) => part === '..' || part === '.')) throw new Error(`dataset case ${value.id} contains an unsafe fixture path: fixture path escapes the dataset directory`);
    }
    ids.add(value.id);
    cases.push(value as LiveDatasetCase);
  }
  if (!cases.length) throw new Error('dataset contains no cases');
  return cases;
}

export function summarize(rows: Array<Record<string, unknown>>) {
  const result: Record<string, unknown> = { turns: rows.length, failed: rows.filter((row) => row.status === 'failed').length };
  for (const key of ['correct_location', 'unsupported_conclusion', 'appropriate_clarification']) {
    const labels = rows.map((row) => row[key]).filter((value): value is boolean => typeof value === 'boolean');
    result[key] = { assessed: labels.length, unassessed: rows.length - labels.length, rate: labels.length ? labels.filter(Boolean).length / labels.length : null };
  }
  const cost: Record<string, unknown> = {};
  for (const key of COST_FIELDS) {
    const values = rows.map((row) => row[key]);
    const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    cost[key] = { known_total: known.reduce((sum, value) => sum + value, 0), unknown_turns: rows.length - known.length, total: known.length === rows.length ? known.reduce((sum, value) => sum + value, 0) : null };
  }
  result.cost = cost;
  return result;
}

export function isProviderQuotaExhausted(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '';
  return /5[- ]hour.*(?:usage )?limit|usage limit|quota.{0,30}(?:exhausted|exceeded)|(?:exhausted|exceeded).{0,30}quota/i.test(message);
}

export function compare(current: any, baseline: any) {
  for (const key of ['model', 'dataset_sha256']) {
    const left = key === 'model' ? JSON.stringify(current[key]) : current[key];
    const right = key === 'model' ? JSON.stringify(baseline[key]) : baseline[key];
    if (left !== right) throw new Error(`cannot compare different ${key}`);
  }
  const currentIds = current.rows.map((row: any) => row.case_id);
  const baselineIds = baseline.rows.map((row: any) => row.case_id);
  if (JSON.stringify(currentIds) !== JSON.stringify(baselineIds)) throw new Error('comparison requires identical ordered cases and turns');
  const costDelta: Record<string, number | null> = {};
  for (const key of COST_FIELDS) {
    const now = current.summary.cost[key].total;
    const before = baseline.summary.cost[key].total;
    costDelta[key] = typeof now === 'number' && typeof before === 'number' ? now - before : null;
  }
  return { cost_delta: costDelta, baseline_quality: baseline.summary, current_quality: current.summary };
}

async function persist(path: string, artifact: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(temporary, path);
}

function inside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error('fixture paths must be relative');
  const target = resolve(root, relativePath);
  const remainder = relative(root, target);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('fixture path escapes workspace');
  return target;
}

export async function runLive(datasetPath: string, outputPath: string, timeoutSeconds = 180) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('timeout must be a positive integer');
  const base = loadRuntimeConfig();
  const resolvedDataset = isAbsolute(datasetPath) ? datasetPath : resolve(base.projectRoot, datasetPath);
  const resolvedOutput = isAbsolute(outputPath) ? outputPath : resolve(base.projectRoot, outputPath);
  const raw = await readFile(resolvedDataset, 'utf8');
  const cases = parseDataset(raw);
  const scratch = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(resolve(tmpdir(), 'harmony-mastra-eval-')));
  const config = {
    ...base,
    dataDir: resolve(scratch, 'data'),
    databaseUrl: `file:${resolve(scratch, 'data', 'runtime.db')}`,
    knowledgeQueryLog: resolve(scratch, 'knowledge-queries.jsonl'),
    caseArchiveDir: resolve(scratch, 'cases'),
    snapshotDir: resolve(scratch, 'snapshots'),
    // 评测的观测 trace 也留在临时目录，避免污染真实 .data 下的会话观测。
    mastraObservabilityDir: resolve(scratch, 'observability'),
  };
  let runtimeForCleanup: Awaited<ReturnType<typeof createRuntimeApp>> | undefined;
  try {
    const runtime = await createRuntimeApp(config);
    runtimeForCleanup = runtime;
    if (!runtime.modelConfiguration.enabled) throw new Error('no configured model; live evaluation failed without skipping');
    const status = runtime.modelConfiguration.status();
    const model = { provider: status.provider, provider_name: status.provider_name, model_name: status.model_name, compatibility_mode: status.compatibility_mode };
    const expectedTurns = cases.reduce((count, item) => count + item.prompts.length, 0);
    const artifact: Record<string, any> = { model, dataset: resolvedDataset, dataset_sha256: createHash('sha256').update(raw).digest('hex'), started_at: new Date().toISOString(), expected_turns: expectedTurns, complete: false, rows: [] };
    let quotaExhausted = false;
    evaluation: for (const item of cases) {
      const work = resolve(scratch, 'fixtures', item.id);
      if (item.files) {
        await mkdir(work, { recursive: true });
        for (const [name, content] of Object.entries(item.files)) {
          const target = inside(work, name);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
        }
      }
      let conversation: DiagnosisRunInput['conversation'] = {
        id: `eval-${item.id}`,
        created_at: new Date().toISOString(),
        messages: [],
        evidence_state: {},
        workspace_path: item.files ? work : null,
        repository_name: item.files ? item.id : null,
      };
      for (const [turn, prompt] of item.prompts.entries()) {
        const user = ChatMessageSchema.parse({ role: 'user', content: prompt });
        const message = ChatMessageSchema.parse({ role: 'assistant', status: 'streaming' });
        const started = Date.now();
        const row: Record<string, unknown> = { case_id: `${item.id}:${turn}`, status: 'failed' };
        let final: any;
        let text = '';
        let capabilitySession: Awaited<ReturnType<typeof createRoundCapabilitySession>> | undefined;
        try {
          conversation.messages = [...conversation.messages, user];
          const abortSignal = AbortSignal.timeout(timeoutSeconds * 1000);
          capabilitySession = await createRoundCapabilitySession(runtime.capabilities, {
            conversationId: conversation.id,
            messageId: message.id,
            runId: `eval-${item.id}-${turn}`,
            workspacePath: conversation.workspace_path ?? null,
            repositoryId: conversation.repository_id ?? null,
            resolvedCommit: conversation.resolved_commit ?? null,
            abortSignal,
            // 评测轮同样按轮次切日志，便于单轮复盘。
            roundStartedAtMs: started,
          });
          const run = runtime.diagnosisAgent.stream({ conversation, content: prompt, toolsets: capabilitySession.toolsets, abortSignal });
          for await (const event of run) {
            if (event.type === 'text') text += event.delta;
            else if (event.type === 'tool-end') message.steps.push(event.event);
            else if (event.type === 'completed' || event.type === 'failed') final = event;
          }
          if (final?.type === 'completed') {
            message.content = final.text || text;
            message.report = null;
            message.status = 'completed';
            message.input_tokens = final.input_tokens;
            message.output_tokens = final.output_tokens;
            message.tool_usage = final.tool_usage;
            conversation.evidence_state = final.evidence_state;
            row.status = 'completed';
            // verdict 由 agent 从「判定：」锚点解析；兜底再从落盘文本解析一次。
            row.verdict = final.verdict ?? parseVerdictMarker(message.content);
          } else {
            message.content = text;
            message.status = 'failed';
            message.error = final?.error ?? 'missing terminal event';
            message.tool_usage = final?.tool_usage ?? {};
            quotaExhausted = isProviderQuotaExhausted(message.error);
          }
        } catch (error) {
          message.status = 'failed';
          message.content = '';
          message.error = error instanceof Error ? runtime.modelConfiguration.redact(error.message) : 'evaluation turn failed';
          quotaExhausted = isProviderQuotaExhausted(message.error);
        } finally {
          await capabilitySession?.close().catch(() => undefined);
        }
        message.created_at = new Date().toISOString();
        conversation.messages = [...conversation.messages, message];
        row.elapsed_ms = Date.now() - started;
        row.input_tokens = message.input_tokens;
        row.output_tokens = message.output_tokens;
        row.model_requests = typeof message.tool_usage.model_requests === 'number'
          ? message.tool_usage.model_requests
          : null;
        row.attempted = message.tool_usage.attempted ?? null;
        row.accepted = message.tool_usage.accepted ?? null;
        row.reused = message.tool_usage.reused ?? null;
        row.result_chars = null;
        row.error = message.error;
        row.input = prompt;
        row.response = message.content;
        row.steps = message.steps;
        const expected = item.expected[turn];
        const verdict = typeof row.verdict === 'string' ? row.verdict : null;
        if (expected.location !== undefined) {
          // 自由文本时代的位置断言：判定为正向前两档且回答中提及期望位置。
          row.correct_location = Boolean(verdict && ['located', 'probable'].includes(verdict) && message.content.includes(expected.location));
        }
        if (expected.verdict !== undefined) {
          const expectedVerdicts = Array.isArray(expected.verdict) ? expected.verdict : [expected.verdict];
          row.expected_verdict_pass = verdict !== null && expectedVerdicts.includes(verdict);
        }
        if (expected.clarification_terms?.length) row.appropriate_clarification = message.status === 'completed' && expected.clarification_terms.every((term) => message.content.includes(term));
        row.unsupported_conclusion = null;
        row.conversation_id = conversation.id;
        row.message_id = message.id;
        artifact.rows.push(redactRecord(row, (value) => runtime.modelConfiguration.redact(value)));
        artifact.summary = summarize(artifact.rows);
        await persist(resolvedOutput, artifact);
        if (quotaExhausted) {
          artifact.stop_reason = 'provider_quota_exhausted';
          break evaluation;
        }
      }
    }
    artifact.complete = !quotaExhausted;
    if (quotaExhausted) artifact.stop_reason = 'provider_quota_exhausted';
    artifact.summary = summarize(artifact.rows);
    await persist(resolvedOutput, artifact);
    return artifact;
  } finally {
    try {
      if (runtimeForCleanup) {
        await Promise.allSettled([
          runtimeForCleanup.capabilities.close(),
          runtimeForCleanup.store.close(),
          Promise.resolve(runtimeForCleanup.mastra.getStorage()?.close()),
        ]);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export async function loadArtifact(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}
