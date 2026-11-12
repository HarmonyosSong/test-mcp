import { AlertTriangle, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { conversationCreateInput } from '../../sessionFlow';

interface NewConversationDialogProps {
  onClose: () => void;
  onCreate: (input: ReturnType<typeof conversationCreateInput>) => Promise<boolean>;
}

export function NewConversationDialog({ onClose, onCreate }: NewConversationDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      if (await onCreate(conversationCreateInput())) onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '创建会话失败。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section className="new-case-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">NEW CONVERSATION</span>
            <h2 id="new-conversation-title">新建会话</h2>
          </div>
          <button className="icon-button light" type="button" onClick={onClose} disabled={pending} title="关闭" aria-label="关闭新建会话">
            <X size={19} />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <p className="snapshot-note">
            无需预选平台、产品线或版本，直接描述问题；Runtime 会结合首条提示词和 LogCenter 关联事实确定排查范围。
          </p>
          {error && <div className="form-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

          {pending && (
            <p className="snapshot-note" role="status">
              会话创建后，Runtime 会根据首条问题中的端、产品线和版本自动准备只读代码快照。
            </p>
          )}

          <footer className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="spin" size={16} /> : <MessageSquare size={16} />}
              {pending ? '正在创建' : '创建会话'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
