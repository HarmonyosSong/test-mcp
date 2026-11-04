import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConversationRecord } from '../domain/schemas.js';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export async function archiveDiagnosisCase(
  directory: string,
  conversation: ConversationRecord,
  messageId: string,
): Promise<string> {
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message || message.role !== 'assistant' || message.status === 'streaming') {
    throw new Error('only a terminal assistant turn can be archived');
  }
  const path = join(directory, `${conversation.id}-${message.id}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    await writeFile(path, prettyJson({
      id: `${conversation.id}-${message.id}`,
      conversation_id: conversation.id,
      message_id: message.id,
      captured_at: new Date().toISOString(),
      input: conversation.messages[conversation.messages.indexOf(message) - 1]?.content ?? '',
      repository_id: conversation.repository_id,
      commit: conversation.resolved_commit,
      message,
      evidence_state: conversation.evidence_state,
      review: null,
      knowledge_entry: null,
    }), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await chmod(path, 0o600);
  return path;
}

export async function appendDiagnosisOutcome(
  queryLogPath: string,
  conversationId: string,
  messageId: string,
  verdict: string | null,
  outcome: string,
): Promise<void> {
  const line = jsonLine({
    ts: new Date().toISOString(),
    tool: 'diagnosis_outcome',
    arguments: {},
    status: 'ok',
    duration_ms: 0,
    conversation_id: conversationId,
    message_id: messageId,
    verdict,
    outcome,
  });
  await mkdir(dirname(queryLogPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(queryLogPath), 0o700);
  await appendFile(queryLogPath, line, { encoding: 'utf8', mode: 0o600 });
  await chmod(queryLogPath, 0o600);
}
