import { LoaderCircle, Settings2, ShieldCheck } from 'lucide-react';

interface ConversationSettingsProps {
  allowed: boolean;
  saving: boolean;
  disabled: boolean;
  onAllowedChange: (allowed: boolean) => void;
}

export function ConversationSettings({
  allowed,
  saving,
  disabled,
  onAllowedChange,
}: ConversationSettingsProps) {
  return (
    <details className="conversation-settings">
      <summary
        className="conversation-settings-trigger"
        title="会话设置"
        aria-label="会话设置"
      >
        {saving ? <LoaderCircle className="spin" size={16} /> : <Settings2 size={16} />}
      </summary>
      <div className="conversation-settings-popover">
        <div className="conversation-settings-title">
          <ShieldCheck size={16} />
          <strong>会话设置</strong>
        </div>
        <label className="consult-compass-setting">
          <input
            type="checkbox"
            role="switch"
            checked={allowed}
            disabled={disabled || saving}
            onChange={(event) => onAllowedChange(event.target.checked)}
            aria-label="允许请求 Compass 服务端协查"
          />
          <span>
            <strong>允许请求 Compass 服务端协查</strong>
            <small>
              仅允许在需要时发起协查，不代表已批准外发。每次发送前仍需你确认具体内容。
            </small>
          </span>
        </label>
      </div>
    </details>
  );
}
