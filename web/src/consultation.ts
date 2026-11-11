import type { ChatConversation, ConsultationAction, ExternalConsultation } from './types';

export function pendingConsultations(
  conversation: Pick<ChatConversation, 'run_state' | 'consultations'>,
): ExternalConsultation[] {
  if (conversation.run_state !== 'waiting_confirmation') return [];
  return (conversation.consultations ?? []).filter((item) => item.status === 'pending');
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

export function consultationDecisionErrorMessage(
  error: unknown,
  decision: ConsultationAction['decision'],
): string {
  const status = errorStatus(error);
  if (status === 409) {
    return '这次协查已被处理或确认状态已变化，请根据刷新后的内容继续操作。';
  }
  if (status === 429) {
    return '当前排查任务较多，请稍后重试；本次不会自动重复提交。';
  }
  const action = decision === 'approve' ? '确认发送' : '拒绝外发';
  const detail = error instanceof Error ? error.message : '';
  return detail ? `${action}失败：${detail}` : `${action}失败，请稍后重试。`;
}
