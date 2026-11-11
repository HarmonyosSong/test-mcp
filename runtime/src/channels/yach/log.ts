/** Safe Yach channel logs for local/prod diagnostics (no secrets). */

import { integrationError, integrationInfo, integrationWarn } from '../../observability/integration-log.js';
import type { YachEvent } from './parse.js';

const PREVIEW = 120;

export function previewText(text: string, max = PREVIEW): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

export function yachInbound(event: YachEvent): void {
  integrationInfo('yach', 'inbound message', {
    chat: event.conversationType === '2' ? 'group' : 'private',
    workCode: event.workCode,
    name: event.displayName || undefined,
    senderId: event.senderId,
    groupId: event.groupId || undefined,
    messageId: event.messageId,
    text: previewText(event.text),
  });
}

export function yachInboundSkipped(reason: string, detail?: Record<string, unknown>): void {
  integrationWarn('yach', 'inbound skipped', { reason, ...detail });
}

export function yachOutbound(event: YachEvent, text: string, status: 'ok' | 'error', error?: string): void {
  const payload = {
    chat: event.conversationType === '2' ? 'group' : 'private',
    toId: event.toId,
    workCode: event.workCode,
    groupId: event.groupId || undefined,
    text: previewText(text),
    ...(error ? { error } : {}),
  };
  if (status === 'ok') integrationInfo('yach', 'outbound markdown sent', payload);
  else integrationError('yach', 'outbound markdown failed', undefined, payload);
}

export function yachHistory(groupId: string, rows: number, summaryChars = 0): void {
  integrationInfo('yach', 'group history loaded', { groupId, rows, summaryChars });
}
