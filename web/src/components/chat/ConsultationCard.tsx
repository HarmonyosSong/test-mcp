import { formatDate } from '../../format';
import type { ExternalConsultation } from '../../types';

const STATUS_LABELS: Record<ExternalConsultation['status'], string> = {
  pending: '待确认（审批流已退役）',
  approved: '已确认',
  rejected: '已拒绝',
  sent: '已发送',
  completed: '已完成',
  failed: '失败',
  cancel_requested: '取消中',
  unknown: '未知',
  expired: '已过期',
};

/**
 * 历史协查记录的只读展示。人工确认流程已随编排层退役：
 * 新协查由 consult_compass 工具在轮内自动完成，这里只负责呈现记录。
 */
export function ConsultationCard({
  consultation,
}: {
  consultation: ExternalConsultation;
}) {
  const outboundText = consultation.outbound_text;
  const hasOutboundText = typeof outboundText === 'string' && outboundText.trim().length > 0;

  return (
    <section className="consultation-card" aria-labelledby={`consultation-${consultation.id}`}>
      <header className="consultation-card-header">
        <div>
          <span className="eyebrow">服务端协查</span>
          <h3 id={`consultation-${consultation.id}`}>Compass 协查记录</h3>
        </div>
        <span className="consultation-status">{STATUS_LABELS[consultation.status] ?? consultation.status}</span>
      </header>

      <dl className="consultation-meta">
        <div>
          <dt>接收方</dt>
          <dd>Compass（服务端研发 Agent）</dd>
        </div>
        <div>
          <dt>协查原因</dt>
          <dd>{consultation.reason || '排查当前问题需要 Compass 协助。'}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{consultation.updated_at ? formatDate(consultation.updated_at) : '未提供'}</dd>
        </div>
      </dl>

      {hasOutboundText && (
        <div className="consultation-outbound-block">
          <span>发送内容</span>
          <pre className="consultation-outbound">{outboundText}</pre>
        </div>
      )}
    </section>
  );
}
