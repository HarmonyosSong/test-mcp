import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import { formatDate } from '../../format';
import type { ChatConversationSummary } from '../../types';

interface ChatPanelProps {
  summaries: ChatConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function ChatPanel({ summaries, activeId, onSelect, onCreate, onDelete }: ChatPanelProps) {
  return (
    <div className="queue-pane" aria-label="聊天会话列表">
      <div className="queue-controls">
        <button className="new-chat-button" type="button" onClick={onCreate}>
          <Plus size={15} />
          <span>新建会话</span>
        </button>
      </div>

      <div className="queue-list scroll-region">
        {summaries.length ? (
          summaries.map((item) => (
            <div
              key={item.id}
              className={`case-card chat-card ${activeId === item.id ? 'selected' : ''}`}
            >
              <button
                type="button"
                className="chat-card-main"
                onClick={() => onSelect(item.id)}
                aria-current={activeId === item.id ? 'true' : undefined}
              >
                <span className="case-card-topline">
                  <span className="chat-card-title">
                    <MessageSquare size={13} aria-hidden="true" />
                    <strong>{item.title}</strong>
                  </span>
                  <span className="case-date">{formatDate(item.updated_at)}</span>
                </span>
                <span className="case-card-meta">
                  <span>{item.message_count} 条消息</span>
                  {item.repository_name && <span>{item.repository_name}</span>}
                  {item.case_ids.length > 0 && <span>{item.case_ids.length} 个案例</span>}
                </span>
              </button>
              <button
                type="button"
                className="chat-card-delete"
                onClick={() => onDelete(item.id)}
                aria-label={`删除会话 ${item.title}`}
                title="删除会话"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <div className="empty-queue">
            <MessageSquare size={26} />
            <strong>还没有会话</strong>
            <span>点击「新建会话」开始提问</span>
          </div>
        )}
      </div>
    </div>
  );
}
