import { CheckCircle2, Clock3, Inbox, Plus, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { caseStatusLabel, currentStage, formatDate, stageLabel } from '../format';
import type { DiagnosticCase } from '../types';

type QueueFilter = 'all' | 'active' | 'completed' | 'failed';

interface QueuePanelProps {
  cases: DiagnosticCase[];
  selectedId: string | null;
  onSelect: (diagnosticCase: DiagnosticCase) => void;
  onNewCase: () => void;
}

const filters: Array<{ key: QueueFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
];

function matchesFilter(item: DiagnosticCase, filter: QueueFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return item.status === 'queued' || item.status === 'running';
  return item.status === filter;
}

function QueueStatusIcon({ status }: { status: DiagnosticCase['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <TriangleAlert size={14} />;
  return <Clock3 className={status === 'running' ? 'pulse' : ''} size={14} />;
}

export function QueuePanel({ cases, selectedId, onSelect, onNewCase }: QueuePanelProps) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [query, setQuery] = useState('');

  const visibleCases = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return cases.filter((item) => {
      const searchable = `${item.title} ${item.description} ${item.workspace_path || ''}`.toLocaleLowerCase(
        'zh-CN',
      );
      return matchesFilter(item, filter) && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [cases, filter, query]);

  return (
    <div className="queue-pane" aria-label="诊断案例队列">
      <div className="queue-controls">
        <button className="new-chat-button" type="button" onClick={onNewCase}>
          <Plus size={15} />
          <span>新建诊断</span>
        </button>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            placeholder="搜索标题或路径"
            aria-label="搜索案例"
          />
        </label>
        <div className="segmented-control" role="tablist" aria-label="案例筛选">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={filter === item.key}
              className={filter === item.key ? 'selected' : ''}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="queue-list scroll-region">
        {visibleCases.length ? (
          visibleCases.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`case-card ${selectedId === item.id ? 'selected' : ''}`}
              onClick={() => onSelect(item)}
              aria-current={selectedId === item.id ? 'true' : undefined}
            >
              <span className="case-card-topline">
                <span className={`status-badge status-${item.status}`}>
                  <QueueStatusIcon status={item.status} />
                  {caseStatusLabel(item.status)}
                </span>
                <span className="case-date">{formatDate(item.updated_at)}</span>
              </span>
              <strong>{item.title}</strong>
              <span className="case-summary">{item.description}</span>
              <span className="case-card-meta">
                <span>{stageLabel(currentStage(item))}</span>
                <span className="case-id">#{item.id.slice(-8)}</span>
              </span>
            </button>
          ))
        ) : (
          <div className="empty-queue">
            <Inbox size={26} />
            <strong>没有匹配的案例</strong>
            <span>调整搜索词或筛选条件</span>
          </div>
        )}
      </div>
    </div>
  );
}
