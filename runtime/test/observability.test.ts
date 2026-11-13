import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationRecordSchema } from '../src/domain/schemas.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../src/observability/cases.js';
import { createClientLogPrivacy, redactClientText } from '../src/security/client-context.js';

test('archives terminal diagnosis cases idempotently and appends correlated outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-observability-'));
  const conversation = ConversationRecordSchema.parse({
    id: 'conv-case', title: 'case', messages: [
      { id: 'msg-user', role: 'user', content: '问题现象' },
      { id: 'msg-assistant', role: 'assistant', content: '结论', status: 'completed' },
    ],
  });
  try {
    const first = await archiveDiagnosisCase(directory, conversation, 'msg-assistant');
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const original = await readFile(first, 'utf8');
    await archiveDiagnosisCase(directory, conversation, 'msg-assistant');
    assert.equal(await readFile(first, 'utf8'), original);
    await appendDiagnosisOutcome(join(directory, 'queries.jsonl'), conversation.id, 'msg-assistant', 'probable', 'completed');
    assert.equal((await stat(join(directory, 'queries.jsonl'))).mode & 0o777, 0o600);
    await appendDiagnosisOutcome(join(directory, 'queries.jsonl'), conversation.id, 'msg-assistant', null, 'failed');
    const entries = (await readFile(join(directory, 'queries.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].conversation_id, conversation.id);
    assert.equal(entries[0].message_id, 'msg-assistant');
    assert.equal(entries[0].verdict, 'probable');
    assert.equal(entries[1].outcome, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('案例归档不脱敏：与会话内容一致全文明文保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-observability-privacy-'));
  const input = '学员编号: student-fixture-001; 联系电话: +8613800000000; 页面打不开';
  const conversation = ConversationRecordSchema.parse({
    id: 'conv-privacy', title: 'case', messages: [
      { id: 'msg-user', role: 'user', content: input },
      { id: 'msg-assistant', role: 'assistant', content: `已核对 ${input}`, status: 'completed' },
    ],
  });
  const privacy = createClientLogPrivacy([input], false);
  try {
    const path = await archiveDiagnosisCase(
      directory,
      conversation,
      'msg-assistant',
      (text) => redactClientText(privacy, text),
    );
    const archived = await readFile(path, 'utf8');
    // 2026-11-13 起不脱敏：uid 与电话均明文保留。
    assert.equal(archived.includes('student-fixture-001'), true);
    assert.equal(archived.includes('+8613800000000'), true);
    assert.match(archived, /页面打不开/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
