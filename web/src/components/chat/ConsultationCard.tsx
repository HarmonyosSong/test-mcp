import { LoaderCircle, SendHorizonal, ShieldAlert, X } from 'lucide-react';
import { formatDate } from '../../format';
import type { ConsultationAction, ExternalConsultation } from '../../types';

interface ConsultationCardProps {
  consultation: ExternalConsultation;
  action: ConsultationAction | null;
  disabled: boolean;
  onDecision: (
    consultationId: string,
    decision: ConsultationAction['decision'],
  ) => void;
}

export function ConsultationCard({
  consultation,
  action,
  disabled,
  onDecision,
}: ConsultationCardProps) {
  const outboundText = consultation.outbound_text;
  const hasOutboundText = typeof outboundText === 'string' && outboundText.trim().length > 0;
  const actionPending = action?.consultationId === consultation.id ? action.decision : null;
  const buttonsDisabled = disabled || Boolean(action) || !hasOutboundText;

  return (
    <section className="consultation-card" aria-labelledby={`consultation-${consultation.id}`}>
      <header className="consultation-card-header">
        <span className="consultation-card-icon" aria-hidden="true">
          <ShieldAlert size={18} />
        </span>
        <div>
          <span className="eyebrow">外发确认</span>
          <h3 id={`consultation-${consultation.id}`}>需要你的确认才能继续协查</h3>
        </div>
        <span className="consultation-status">等待确认</span>
      </header>

      <dl className="consultation-meta">
        <div>
          <dt>接收方</dt>
          <dd>Compass</dd>
        </div>
        <div>
          <dt>协查原因</dt>
          <dd>{consultation.reason || '为继续排查当前问题，需要请求 Compass 协助。'}</dd>
        </div>
        <div>
          <dt>过期时间</dt>
          <dd>{consultation.expires_at ? formatDate(consultation.expires_at) : '未提供'}</dd>
        </div>
      </dl>

      <div className="consultation-outbound-block">
        <span>将完整发送以下内容</span>
        {hasOutboundText ? (
          <pre className="consultation-outbound">{outboundText}</pre>
        ) : (
          <p className="consultation-missing-content" role="alert">
            暂时无法读取外发内容，请刷新会话后再操作。
          </p>
        )}
      </div>

      <p className="consultation-card-note">
        请仔细核对。确认后只会发送这里展示的文字；外发内容不能在本页面修改。
      </p>

      <footer className="consultation-card-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={buttonsDisabled}
          onClick={() => onDecision(consultation.id, 'reject')}
        >
          {actionPending === 'reject' ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <X size={15} />
          )}
          拒绝外发
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={buttonsDisabled}
          onClick={() => onDecision(consultation.id, 'approve')}
        >
          {actionPending === 'approve' ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <SendHorizonal size={15} />
          )}
          确认发送并继续排查
        </button>
      </footer>
    </section>
  );
}
