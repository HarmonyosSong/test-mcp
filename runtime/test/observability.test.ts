import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationRecordSchema } from '../src/domain/schemas.js';
import { appendDiagnosisOutcome, archiveDiagnosisCase } from '../src/observability/cases.js';

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
