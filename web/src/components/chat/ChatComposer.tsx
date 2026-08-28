import { FileSearch, SendHorizonal, Square } from 'lucide-react';
import { type ReactNode, useState } from 'react';

interface ChatComposerProps {
  disabled: boolean;
  sending: boolean;
  canPromote: boolean;
  promotePending: boolean;
  /** 操作区左侧的附加内容（模型选择器、上下文用量等） */
  toolbarExtra?: ReactNode;
  onSend: (content: string) => void;
  onStop: () => void;
  onPromote: () => void;
}

export function ChatComposer({
  disabled,
  sending,
  canPromote,
  promotePending,
  toolbarExtra,
  onSend,
  onStop,
  onPromote,
}: ChatComposerProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const content = value.trim();
    if (!content || disabled || sending) return;
    onSend(content);
    setValue('');
  };

  return (
    <div className="chat-composer">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={
          disabled ? '配置模型后即可开始对话' : '描述你遇到的 HarmonyOS 问题，可粘贴日志或代码…'
        }
        disabled={disabled || sending}
        rows={3}
        aria-label="消息输入框"
      />
      <div className="chat-composer-actions">
        <button
          type="button"
          className="chat-promote-button"
          onClick={onPromote}
          disabled={disabled || sending || !canPromote || promotePending}
          title="从当前对话提取结构化诊断案例"
        >
          <FileSearch size={15} />
          <span>{promotePending ? '正在提取…' : '生成诊断案例'}</span>
        </button>
        {toolbarExtra}
        <span className="chat-composer-spacer" />
        {sending ? (
          <button
            type="button"
            className="chat-stop-button"
            onClick={onStop}
            title="停止当前回复"
          >
            <Square size={14} />
            <span>停止</span>
          </button>
        ) : (
          <button
            type="button"
            className="chat-send-button"
            onClick={submit}
            disabled={disabled || !value.trim()}
          >
            <SendHorizonal size={15} />
            <span>发送</span>
          </button>
        )}
      </div>
    </div>
  );
}
