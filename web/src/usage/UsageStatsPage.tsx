import { BarChart3, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchUsageStats } from './api';
import { navigateToUsage, readUsageRangeParam } from './route';
import type { UsageFeedbackVerdict, UsageRangeKey, UsageStatsResult } from './types';
import './styles.css';

const RANGE_OPTIONS: Array<{ key: UsageRangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨日' },
  { key: '3d', label: '近 3 天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
];

function feedbackLabel(value: UsageFeedbackVerdict): string {
  if (value === 'correct') return '正确';
  if (value === 'vague') return '模糊';
  if (value === 'failed') return '失败';
  return '未反馈';
}

function channelLabel(channel: 'web' | 'yach_im'): string {
  return channel === 'yach_im' ? '知音楼' : 'Web';
}

function rangeLabel(key: UsageRangeKey): string {
  return RANGE_OPTIONS.find((item) => item.key === key)?.label ?? key;
}

export function UsageStatsPage() {
  const [range, setRange] = useState<UsageRangeKey>(() => readUsageRangeParam());
  const [stats, setStats] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchUsageStats(range, controller.signal)
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setStats(next);
      })
      .catch((cause) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setStats(null);
        setError(cause instanceof Error ? cause.message : '加载失败');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [range]);

  const onRangeChange = (key: UsageRangeKey) => {
    if (key === range) return;
    setRange(key);
    navigateToUsage(key);
  };

  const summary = stats?.summary;

  return (
    <section className="usage-page" aria-label="使用统计">
      <header className="usage-page-header">
        <span className="usage-page-eyebrow">USAGE STATS</span>
        <h1>
          <BarChart3 size={18} />
          问题排查助手使用数据
        </h1>
      </header>

      <div className="feedback-stats-range" role="group" aria-label="时间范围">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={option.key === range ? 'selected' : ''}
            onClick={() => onRangeChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="usage-note">
        当前维度：{rangeLabel(range)}
        {stats ? (
          <>
            {' '}
            · 统计区间：{stats.from}
            {stats.from !== stats.to ? ` ~ ${stats.to}` : ''}
          </>
        ) : null}
      </p>

      {loading && (
        <p className="usage-note">
          <LoaderCircle className="spin" size={14} /> 正在统计…
        </p>
      )}
      {error && <p className="usage-note usage-note-error">加载失败：{error}</p>}

      {summary && !loading && (
        <>
          <div className="usage-cards feedback-stats-cards">
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value">{summary.unique_users}</span>
              <span className="usage-card-label feedback-stats-label">使用人数</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value">{summary.conversations}</span>
              <span className="usage-card-label feedback-stats-label">会话数</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value">{summary.with_verdict}</span>
              <span className="usage-card-label feedback-stats-label">有结论</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value feedback-stats-ok">
                {summary.feedback.correct}
              </span>
              <span className="usage-card-label feedback-stats-label">反馈正确</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value feedback-stats-vague">
                {summary.feedback.vague}
              </span>
              <span className="usage-card-label feedback-stats-label">反馈模糊</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value feedback-stats-bad">
                {summary.feedback.failed}
              </span>
              <span className="usage-card-label feedback-stats-label">反馈失败</span>
            </div>
            <div className="usage-card feedback-stats-card">
              <span className="usage-card-value feedback-stats-value">{summary.feedback.none}</span>
              <span className="usage-card-label feedback-stats-label">未反馈</span>
            </div>
          </div>

          {stats.items.length > 0 ? (
            <div className="usage-table-wrap">
              <table className="usage-table feedback-stats-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>工号</th>
                    <th>渠道</th>
                    <th>问题</th>
                    <th>结论</th>
                    <th>反馈状态</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.items.map((item) => (
                    <tr key={`${item.conversation_id}-${item.at}`}>
                      <td>{item.owner_display_name || item.owner_subject || '匿名'}</td>
                      <td>{item.owner_subject || '—'}</td>
                      <td>{channelLabel(item.channel)}</td>
                      <td className="usage-q">{item.question}</td>
                      <td className="usage-c">{item.verdict || '未完成'}</td>
                      <td>{feedbackLabel(item.feedback)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="usage-note">该时间范围内暂无使用记录。</p>
          )}
        </>
      )}
    </section>
  );
}
