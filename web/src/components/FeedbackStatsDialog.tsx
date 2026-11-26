import { useCallback, useEffect, useState } from 'react';
import { BarChart3, LoaderCircle, X } from 'lucide-react';
import { api } from '../api';
import type { YachFeedbackStats } from '../types';

type RangeKey = '7d' | '30d' | 'all';

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { label: '全部', key: 'all' },
];

function rangeParams(key: RangeKey): { from?: string; to?: string } {
  if (key === 'all') return {};
  const days = key === '7d' ? 7 : 30;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10) };
}

function percent(value: number | null): string {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

/** 问题归档统计（知音楼评测集）：故障终稿数与支持老师回评的正确/失败分布。 */
export function FeedbackStatsDialog({ onClose }: { onClose: () => void }) {
  const [range, setRange] = useState<RangeKey>('7d');
  const [stats, setStats] = useState<YachFeedbackStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: RangeKey) => {
    setLoading(true);
    setError(null);
    try {
      setStats(await api.yachFeedbackStats(rangeParams(key)));
    } catch (cause) {
      setStats(null);
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="model-settings-dialog feedback-stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="问题归档统计"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <span className="eyebrow">YACH FEEDBACK</span>
          <h2>
            <BarChart3 size={18} />
            问题归档统计
          </h2>
          <button type="button" className="icon-button light" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="feedback-stats-range" role="group" aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={option.key === range ? 'selected' : ''}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading && (
          <p className="feedback-stats-note">
            <LoaderCircle className="spin" size={14} /> 正在统计…
          </p>
        )}
        {error && <p className="feedback-stats-note feedback-stats-error">加载失败：{error}</p>}

        {stats && !loading && (
          <>
            <div className="feedback-stats-cards">
              <div className="feedback-stats-card">
                <span className="feedback-stats-value">{stats.totals.final_answers}</span>
                <span className="feedback-stats-label">故障终稿</span>
              </div>
              <div className="feedback-stats-card">
                <span className="feedback-stats-value">{stats.totals.archived}</span>
                <span className="feedback-stats-label">已归档</span>
              </div>
              <div className="feedback-stats-card">
                <span className="feedback-stats-value feedback-stats-ok">{stats.totals.correct}</span>
                <span className="feedback-stats-label">分析正确</span>
              </div>
              <div className="feedback-stats-card">
                <span className="feedback-stats-value feedback-stats-vague">{stats.totals.vague}</span>
                <span className="feedback-stats-label">分析模糊</span>
              </div>
              <div className="feedback-stats-card">
                <span className="feedback-stats-value feedback-stats-bad">{stats.totals.failed}</span>
                <span className="feedback-stats-label">分析失败</span>
              </div>
              <div className="feedback-stats-card">
                <span className="feedback-stats-value" title="正确 ÷ 已归档（模糊计为未达标）">
                  {percent(stats.totals.accuracy)}
                </span>
                <span className="feedback-stats-label">归档正确率</span>
              </div>
            </div>

            {stats.by_user.length > 0 ? (
              <table className="feedback-stats-table">
                <thead>
                  <tr>
                    <th>支持老师</th>
                    <th>正确</th>
                    <th>模糊</th>
                    <th>失败</th>
                    <th>合计</th>
                    <th>正确率</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_user.map((row) => (
                    <tr key={row.work_code ?? row.name ?? '(未知)'}>
                      <td>{row.name || row.work_code || '(未知)'}</td>
                      <td>{row.correct}</td>
                      <td>{row.vague}</td>
                      <td>{row.failed}</td>
                      <td>{row.total}</td>
                      <td>{percent(row.total > 0 ? row.correct / row.total : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="feedback-stats-note">该时间范围内还没有归档记录。</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
