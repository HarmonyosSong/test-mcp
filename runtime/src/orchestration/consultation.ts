import { createHash, randomUUID } from 'node:crypto';

export type ExternalConsultationStatus =
  | 'pending' | 'approved' | 'rejected' | 'sent' | 'completed'
  | 'failed' | 'cancel_requested' | 'unknown' | 'expired';

export type ExternalConsultation = {
  id: string;
  conversation_id: string;
  message_id: string;
  run_id: string;
  status: ExternalConsultationStatus;
  reason: string;
  outbound_text: string;
  outbound_digest: string;
  redaction_version: string;
  attachment_items: string[];
  expires_at: string;
  task_id: string | null;
  context_id: string | null;
  created_at: string;
  updated_at: string;
};

export class ExternalConsultationError extends Error {
  public constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalConsultationError';
  }
}

export function createExternalConsultation(input: {
  conversationId: string;
  messageId: string;
  runId: string;
  reason: string;
  outboundText: string;
  redact: (text: string) => string;
  now?: Date;
  ttlMs?: number;
}): ExternalConsultation {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('consultation ttlMs must be positive');
  const outboundText = input.redact(input.outboundText).trim();
  if (!outboundText) {
    // 错误码保持兼容；2026-11-13 起 redact 为透传（不脱敏），此处仅防空文本。
    throw new ExternalConsultationError('redaction_failed', '外发内容为空');
  }
  const timestamp = now.toISOString();
  return {
    id: `consult-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    run_id: input.runId,
    status: 'pending',
    reason: input.reason,
    outbound_text: outboundText,
    outbound_digest: digest(outboundText),
    redaction_version: 'runtime-v1',
    attachment_items: [],
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    task_id: null,
    context_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function approveExternalConsultation(
  consultation: ExternalConsultation,
  input: { conversationId: string; runId: string; now?: Date },
): ExternalConsultation {
  assertDecisionAllowed(consultation, input);
  return update(consultation, 'approved', input.now);
}

export function rejectExternalConsultation(
  consultation: ExternalConsultation,
  input: { conversationId: string; runId: string; now?: Date },
): ExternalConsultation {
  assertDecisionAllowed(consultation, input);
  return update(consultation, 'rejected', input.now);
}

export function expireExternalConsultation(
  consultation: ExternalConsultation,
  input: { conversationId: string; runId: string; now?: Date },
): ExternalConsultation {
  const now = input.now ?? new Date();
  if (consultation.conversation_id !== input.conversationId || consultation.run_id !== input.runId) {
    throw new ExternalConsultationError('scope_mismatch', '咨询记录不属于当前会话轮次');
  }
  if (consultation.status !== 'pending') {
    throw new ExternalConsultationError('invalid_state', '咨询记录不在待确认状态');
  }
  assertDigest(consultation);
  if (now.getTime() < Date.parse(consultation.expires_at)) {
    throw new ExternalConsultationError('invalid_state', '咨询确认尚未过期');
  }
  return update(consultation, 'expired', now);
}

export function markExternalConsultationSent(
  consultation: ExternalConsultation,
  now = new Date(),
): ExternalConsultation {
  if (consultation.status !== 'approved') {
    throw new ExternalConsultationError('invalid_state', '只有已批准的咨询可以发送');
  }
  assertDigest(consultation);
  return update(consultation, 'sent', now);
}

export function transitionExternalConsultation(
  consultation: ExternalConsultation,
  status: 'completed' | 'failed' | 'cancel_requested' | 'unknown',
  identity: { taskId?: string | null; contextId?: string | null } = {},
  now = new Date(),
): ExternalConsultation {
  if (consultation.status !== 'sent' && consultation.status !== 'cancel_requested') {
    throw new ExternalConsultationError('invalid_state', '远端咨询尚未发送或已终态');
  }
  return {
    ...update(consultation, status, now),
    task_id: identity.taskId === undefined ? consultation.task_id : identity.taskId,
    context_id: identity.contextId === undefined ? consultation.context_id : identity.contextId,
  };
}

function assertDecisionAllowed(
  consultation: ExternalConsultation,
  input: { conversationId: string; runId: string; now?: Date },
): void {
  if (consultation.conversation_id !== input.conversationId || consultation.run_id !== input.runId) {
    throw new ExternalConsultationError('scope_mismatch', '咨询记录不属于当前会话轮次');
  }
  if (consultation.status !== 'pending') {
    throw new ExternalConsultationError('invalid_state', '咨询记录不在待确认状态');
  }
  if ((input.now ?? new Date()).getTime() >= Date.parse(consultation.expires_at)) {
    throw new ExternalConsultationError('expired', '咨询确认已过期');
  }
  assertDigest(consultation);
}

function assertDigest(consultation: ExternalConsultation): void {
  if (consultation.attachment_items.length !== 0 || digest(consultation.outbound_text) !== consultation.outbound_digest) {
    throw new ExternalConsultationError('digest_mismatch', '外发内容或附件已变化');
  }
}

function update(
  consultation: ExternalConsultation,
  status: ExternalConsultationStatus,
  now = new Date(),
): ExternalConsultation {
  return { ...consultation, status, updated_at: now.toISOString() };
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
