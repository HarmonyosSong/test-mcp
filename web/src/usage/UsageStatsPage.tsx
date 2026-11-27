import { BarChart3, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fetchUsageStats } from './api';
import { navigateToUsage, readUsageDateParam } from './route';
import type { UsageFeedbackVerdict, UsageStatsResult } from './types';
import './styles.css';

function yesterdayLocalYmd(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function feedbackLabel(value: UsageFeedbackVerdict): string {
  if (value === 'correct') return '正确';
  if (value === 'vague') return '模糊';
  if (value === 'failed') return '失败';
  return '—';
}

function channelLabel(channel: 'web' | 'yach_im'): string {
  return channel === 'yach_im' ? '知音楼' : 'Web';
}

export function UsageStatsPage() {
  const [date, setDate] = useState(() => readUsageDateParam() || yesterdayLocalYmd());
  const [stats, setStats] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextDate: string) => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchUsageStats(nextDate));
    } catch (cause) {
      setStats(null);
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const onDateChange = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    setDate(value);
    navigateToUsage(value);
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
        <div className="usage-date-row">
          <label htmlFor="usage-date">日期</label>
          <input
            id="usage-date"
            type="date"
            value={date}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </div>
      </header>

      {loading && (
        <p className="usage-note">
          <LoaderCircle className="spin" size={14} /> 正在统计…
        </p>
      )}
      {error && <p className="usage-note usage-note-error">加载失败：{error}</p>}

      {summary && !loading && (
        <>
          <div className="usage-cards">
            <div className="usage-card">
              <span className="usage-card-value">{summary.unique_users}</span>
              <span className="usage-card-label">使用人数</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value">{summary.conversations}</span>
              <span className="usage-card-label">会话数</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value">{summary.with_verdict}</span>
              <span className="usage-card-label">有结论</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value usage-card-ok">{summary.feedback.correct}</span>
              <span className="usage-card-label">反馈正确</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value usage-card-vague">{summary.feedback.vague}</span>
              <span className="usage-card-label">反馈模糊</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value usage-card-bad">{summary.feedback.failed}</span>
              <span className="usage-card-label">反馈失败</span>
            </div>
            <div className="usage-card">
              <span className="usage-card-value">{summary.feedback.none}</span>
              <span className="usage-card-label">未反馈</span>
            </div>
          </div>

          {stats.items.length > 0 ? (
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>使用者</th>
                    <th>渠道</th>
                    <th>问题</th>
                    <th>结论</th>
                    <th>反馈</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.items.map((item) => (
                    <tr key={item.conversation_id}>
                      <td>
                        {item.owner_display_name || item.owner_subject || '匿名'}
                        {item.owner_display_name && item.owner_subject ? (
                          <div className="usage-channel">{item.owner_subject}</div>
                        ) : null}
                      </td>
                      <td className="usage-channel">{channelLabel(item.channel)}</td>
                      <td className="usage-q">{item.question}</td>
                      <td className="usage-c">{item.verdict || '未完成'}</td>
                      <td>{feedbackLabel(item.feedback)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="usage-note">该日暂无使用记录。</p>
          )}
        </>
      )}
    </section>
  );
}
