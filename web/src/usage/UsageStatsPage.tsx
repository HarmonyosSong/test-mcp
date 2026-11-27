import { BarChart3, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchUsageStats } from './api';
import { navigateToUsage, readUsageRangeParam } from './route';
import type { UsageRangeKey, UsageStatsItem, UsageStatsResult } from './types';
import './styles.css';

/** 归档统计按使用人聚合：姓名（显示名兜底工号）+ 三档评价 + 没有结论（未归档）计数。 */
interface FeedbackRank {
  name: string;
  correct: number;
  vague: number;
  failed: number;
  unconcluded: number;
  total: number;
  /** 正确/已评价（模糊计为未达标；没有结论不参与正确率），无已评价时为 null。 */
  accuracy: number | null;
}

function rankFeedbackByUser(items: UsageStatsItem[]): FeedbackRank[] {
  const buckets = new Map<string, FeedbackRank>();
  for (const item of items) {
    const label = item.owner_display_name?.trim() || item.owner_subject?.trim() || '匿名';
    const existing = buckets.get(label);
    if (existing) {
      if (item.feedback === 'none') existing.unconcluded += 1;
      else existing[item.feedback] += 1;
      existing.total += 1;
    } else {
      buckets.set(label, {
        name: label,
        correct: item.feedback === 'correct' ? 1 : 0,
        vague: item.feedback === 'vague' ? 1 : 0,
        failed: item.feedback === 'failed' ? 1 : 0,
        unconcluded: item.feedback === 'none' ? 1 : 0,
        total: 1,
        accuracy: null,
      });
    }
  }
  const ranks = [...buckets.values()];
  for (const rank of ranks) {
    const evaluated = rank.correct + rank.vague + rank.failed;
    rank.accuracy = evaluated > 0 ? rank.correct / evaluated : null;
  }
  return ranks.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function formatAccuracy(accuracy: number | null): string {
  if (accuracy == null) return '—';
  return `${(accuracy * 100).toFixed(1)}%`;
}

/** 正确率着色：>=80% 绿，<50% 红，中间黄（复用 feedback-stats 色板）；无评价不着色。 */
function accuracyClass(accuracy: number | null): string {
  if (accuracy == null) return 'usage-accuracy';
  if (accuracy >= 0.8) return 'usage-accuracy feedback-stats-ok';
  if (accuracy < 0.5) return 'usage-accuracy feedback-stats-bad';
  return 'usage-accuracy feedback-stats-vague';
}

const RANGE_OPTIONS: Array<{ key: UsageRangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨日' },
  { key: '3d', label: '近 3 天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
];

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
  const feedbackRanks = stats ? rankFeedbackByUser(stats.items) : [];
  const feedbackTotals = feedbackRanks.reduce(
    (acc, row) => ({
      correct: acc.correct + row.correct,
      vague: acc.vague + row.vague,
      failed: acc.failed + row.failed,
      unconcluded: acc.unconcluded + row.unconcluded,
      total: acc.total + row.total,
    }),
    { correct: 0, vague: 0, failed: 0, unconcluded: 0, total: 0 },
  );
  const evaluatedTotal = feedbackTotals.correct + feedbackTotals.vague + feedbackTotals.failed;
  const totalAccuracy = evaluatedTotal > 0 ? feedbackTotals.correct / evaluatedTotal : null;

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

          {feedbackRanks.length > 0 ? (
            <div className="usage-table-wrap">
              <h2 className="usage-section-title">归档统计（按使用人）</h2>
              <table className="usage-table feedback-stats-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>分析正确</th>
                    <th>分析模糊</th>
                    <th>分析失败</th>
                    <th>没有结论</th>
                    <th>合计</th>
                    <th>正确率</th>
                  </tr>
                </thead>
                <tbody>
                  {feedbackRanks.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.correct}</td>
                      <td>{row.vague}</td>
                      <td>{row.failed}</td>
                      <td>{row.unconcluded}</td>
                      <td>{row.total}</td>
                      <td className={accuracyClass(row.accuracy)}>{formatAccuracy(row.accuracy)}</td>
                    </tr>
                  ))}
                  <tr className="usage-table-total">
                    <td>合计</td>
                    <td>{feedbackTotals.correct}</td>
                    <td>{feedbackTotals.vague}</td>
                    <td>{feedbackTotals.failed}</td>
                    <td>{feedbackTotals.unconcluded}</td>
                    <td>{feedbackTotals.total}</td>
                    <td className={accuracyClass(totalAccuracy)}>
                      {formatAccuracy(totalAccuracy)}
                    </td>
                  </tr>
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
