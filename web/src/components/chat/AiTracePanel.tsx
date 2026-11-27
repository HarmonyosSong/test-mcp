import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  FileJson,
  FileText,
  Minus,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';

import { api } from '../../api';
import { formatDate, formatTokens } from '../../format';
import { toolIcon } from './toolIcons';
import type {
  AiTraceDetail,
  AiTraceOrEventDetail,
  AiTraceStepUsage,
  AiTraceSummary,
  AiTimelineEventDetail,
} from '../../types';
import { isTimelineEventDetail } from '../../types';
import { MarkdownContent } from './MarkdownContent';
import { downloadText, tracesToMarkdown } from './aiTraceExport';

/**
 * PenguinHarness 侧边栏：参考 PenguinHarness 项目的 Trace 视图观测 AI 运行轨迹。
 * 轮内是「泳道时间线 + 事件流」：模型泳道（思考/回复/工具调用生成）、
 * 每个工具一条泳道（同名重叠自动拆行）、未归属工具进「其他」泳道；
 * 事件流按 请求开始 → 模型回复 → 工具调用 → 工具结果 → 用量 → 请求结束 逐行展开。
 * 条与行双向联动：悬停/点击时只淡出不匹配项，绝不用外框。
 */

/* ---------- 小工具 ---------- */

/** 时长人性化：<1s 给毫秒，<60s 给一位小数的秒，再长给分秒。 */
function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 百分比（缓存命中率），无数据给占位。 */
function formatPercent(ratio: number | null): string {
  return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
}

/** ISO 时间串 → epoch 毫秒；缺失或非法给 null（旧 trace 没有 started_at/ended_at）。 */
function tsOf(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 事件行时间戳：本地 HH:MM:SS.mmm。 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 单行摘要：取首行并截断。 */
function firstLine(text: string | undefined | null, max = 100): string {
  if (!text) return '';
  const line = text.split('\n', 1)[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/* ---------- 图标 ---------- */

/** 统一的线图标渲染：24×24 路径、1.7 描边、currentColor（与 PenguinHarness GlyphIcon 同规）。 */
function Glyph({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ph-glyph"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** 事件类型图标（24×24 线路径，取自 PenguinHarness trace-event-row 的 TYPE_ICON）。 */
const EVENT_ICON = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0',
  text: 'M8 10h8M8 14h5M21 12a9 9 0 1 1-4-7.5',
  thinking: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11z',
  tool_call:
    'M14.7 6.3a4 4 0 0 0-5 5L4 17v3h3l5.7-5.7a4 4 0 0 0 5-5l-2.5 2.5-2-2 2.5-2.5z',
  tool_call_output: 'M4 6l4 4-4 4M12 18h8',
  token_usage: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  request_begin: 'M5 12h14M13 6l6 6-6 6',
  request_end: 'M19 12H5M11 6l-6 6 6 6',
  final: 'M5 21V4m0 1h12l-2 4 2 4H5',
} as const;

/* ---------- 统计 ---------- */

/** 一轮 trace 的聚合统计：全部从 detail 的 steps 推导，与 PenguinHarness 的「按轮」口径一致。 */
interface RoundStats {
  toolCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  modelMs: number;
  toolMs: number;
  /** 上下文快照：本轮最后一个带用量的步骤的输入 tokens（含历史），不是吞吐累计。 */
  contextTokens: number | null;
}

function roundStats(detail: AiTraceDetail): RoundStats {
  const stats: RoundStats = {
    toolCalls: detail.orphan_tools?.length ?? 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    modelMs: 0,
    toolMs: 0,
    contextTokens: null,
  };
  for (const step of detail.steps) {
    stats.toolCalls += step.tools.length;
    if (step.duration_ms != null) stats.modelMs += step.duration_ms;
    for (const tool of step.tools) {
      if (tool.duration_ms != null) stats.toolMs += tool.duration_ms;
    }
    if (step.usage?.inputTokens != null) {
      stats.inputTokens += step.usage.inputTokens;
      stats.cacheReadTokens += step.usage.inputDetails?.cacheRead ?? 0;
      stats.contextTokens = step.usage.inputTokens;
    }
    if (step.usage?.outputTokens != null) stats.outputTokens += step.usage.outputTokens;
  }
  return stats;
}

/** 输出 TPS：输出 tokens ÷ 模型生成耗时（与 PenguinHarness 的 TPS 口径一致，分母不含工具时间）。 */
function tpsOf(outputTokens: number, modelMs: number): string {
  if (outputTokens <= 0 || modelMs <= 0) return '—';
  return `${(outputTokens / (modelMs / 1000)).toFixed(1)}`;
}

/** 缓存命中率：命中 ÷ 输入。 */
function hitRateOf(inputTokens: number, cacheReadTokens: number): number | null {
  if (inputTokens <= 0) return null;
  return cacheReadTokens / inputTokens;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ph-summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="ph-chip" title={title ?? label} aria-label={title ?? label}>
      <em>{label}</em>
      {value}
    </span>
  );
}

/* ---------- 泳道时间线 ---------- */

/** 段类别：图例与淡出联动的最小单位。 */
type SegKind = 'think' | 'reply' | 'toolgen' | 'tool' | 'fail' | 'other';

const SEG_COLOR: Record<SegKind, string> = {
  think: '#8b5cf6',
  reply: '#0ea5e9',
  toolgen: '#f59e0b',
  tool: '#10b981',
  fail: '#ef4444',
  other: '#9ca3af',
};

const LEGEND_ITEMS: { kind: SegKind; label: string; title?: string }[] = [
  { kind: 'think', label: '首 token 前', title: '首 token 前（排队与预填充）；思考内容见事件流「思考」行' },
  { kind: 'reply', label: '模型回复' },
  { kind: 'toolgen', label: '工具调用生成' },
  { kind: 'tool', label: '工具执行' },
  { kind: 'fail', label: '执行失败' },
  { kind: 'other', label: '其他', title: '未归属步骤的工具等' },
];

/** 模型泳道一段：TTFT 子段（思考）或生成子段（回复/工具调用生成）。 */
interface ModelSeg {
  key: string;
  kind: 'think' | 'reply' | 'toolgen';
  startMs: number;
  endMs: number;
  title: string;
}

/** 工具泳道一段。 */
interface ToolSeg {
  key: string;
  name: string;
  startMs: number;
  endMs: number;
  ok: boolean | null;
  title: string;
}

interface ToolLane {
  label: string;
  rows: ToolSeg[][];
}

interface TimelineModel {
  t0: number;
  totalMs: number;
  modelSegs: ModelSeg[];
  toolLanes: ToolLane[];
  otherLane: ToolLane | null;
}

/** 同名工具按开始时间贪心拆行：时间重叠才开新行（移植 PenguinHarness lane-packing 的思想）。 */
function packRows(segs: ToolSeg[]): ToolSeg[][] {
  const rows: ToolSeg[][] = [];
  for (const seg of [...segs].sort((a, b) => a.startMs - b.startMs)) {
    const row = rows.find((r) => r[r.length - 1].endMs <= seg.startMs);
    if (row) row.push(seg);
    else rows.push([seg]);
  }
  return rows;
}

/**
 * 从一轮 detail 构建泳道模型；全部事件都没有时间戳（旧 trace）时返回 null，
 * 调用方回退到等比时间线。能定位的段才进泳道，缺时间戳的段只在事件流里出现。
 */
function buildLanes(detail: AiTraceDetail): TimelineModel | null {
  const modelSegs: ModelSeg[] = [];
  const toolSegs: ToolSeg[] = [];
  const orphanSegs: ToolSeg[] = [];
  let t0 = Infinity;
  let t1 = -Infinity;
  const mark = (a: number, b: number) => {
    t0 = Math.min(t0, a);
    t1 = Math.max(t1, b);
  };

  for (const step of detail.steps) {
    const start = tsOf(step.started_at);
    const end = tsOf(step.ended_at);
    if (start != null && end != null && end >= start) {
      mark(start, end);
      const key = `s-${step.step_index}`;
      const ttft = step.time_to_first_token_ms;
      const thinkEnd = ttft != null && ttft > 0 ? Math.min(start + ttft, end) : start;
      if (thinkEnd > start) {
        modelSegs.push({
          key,
          kind: 'think',
          startMs: start,
          endMs: thinkEnd,
          title: `步骤 ${step.step_index} · 首 token 前（排队与预填充） ${humanMs(thinkEnd - start)}`,
        });
      }
      if (end > thinkEnd) {
        const hasTools = step.tools.length > 0;
        modelSegs.push({
          key,
          kind: hasTools ? 'toolgen' : 'reply',
          startMs: thinkEnd,
          endMs: end,
          title: `步骤 ${step.step_index} · ${hasTools ? '工具调用生成' : '模型回复'} ${humanMs(end - thinkEnd)}`,
        });
      }
    }
    step.tools.forEach((tool, index) => {
      const ts = tsOf(tool.started_at);
      const te = tsOf(tool.ended_at);
      if (ts == null || te == null || te < ts) return;
      mark(ts, te);
      const status = tool.success === true ? ' ✓' : tool.success === false ? ' ✗' : '';
      toolSegs.push({
        key: `t-${step.step_index}-${index}`,
        name: tool.name,
        startMs: ts,
        endMs: te,
        ok: tool.success,
        title: `${tool.name}${status} · ${humanMs(te - ts)}`,
      });
    });
  }

  (detail.orphan_tools ?? []).forEach((tool, index) => {
    const ts = tsOf(tool.started_at);
    const te = tsOf(tool.ended_at);
    if (ts == null || te == null || te < ts) return;
    mark(ts, te);
    const status = tool.success === true ? ' ✓' : tool.success === false ? ' ✗' : '';
    orphanSegs.push({
      key: `o-${index}`,
      name: tool.name,
      startMs: ts,
      endMs: te,
      ok: tool.success,
      title: `（未归属步骤）${tool.name}${status} · ${humanMs(te - ts)}`,
    });
  });

  if (t0 === Infinity) return null;

  const byName = new Map<string, ToolSeg[]>();
  for (const seg of toolSegs) {
    const list = byName.get(seg.name) ?? [];
    list.push(seg);
    byName.set(seg.name, list);
  }
  const toolLanes = [...byName.entries()].map(([label, segs]) => ({
    label,
    rows: packRows(segs),
  }));
  const otherLane =
    orphanSegs.length > 0 ? { label: '其他（未归属）', rows: packRows(orphanSegs) } : null;
  return { t0, totalMs: Math.max(t1 - t0, 1), modelSegs, toolLanes, otherLane };
}

/* ----- 缩放视口（Premiere 式：拖窗口平移、拖两端手柄缩放、双击复位） ----- */

interface TlView {
  start: number;
  span: number;
}

const FULL_VIEW: TlView = { start: 0, span: 1 };
/** 最小可视窗口：全程的 5%（约 20× 放大）。 */
const MIN_SPAN = 0.05;

function clampView(v: TlView): TlView {
  const span = Math.min(1, Math.max(MIN_SPAN, v.span));
  return { start: Math.min(1 - span, Math.max(0, v.start)), span };
}

/** 时间段 → 可视窗口内的百分比位置；不在窗口内返回 null。 */
function place(
  view: TlView,
  t0: number,
  total: number,
  a: number,
  b: number,
): { left: number; width: number } | null {
  const end = view.start + view.span;
  const f0 = (a - t0) / total;
  const f1 = (b - t0) / total;
  if (f1 < view.start || f0 > end) return null;
  const left = Math.max(0, ((Math.max(f0, view.start) - view.start) / view.span) * 100);
  const right = Math.min(100, ((Math.min(f1, end) - view.start) / view.span) * 100);
  return { left, width: Math.max(right - left, 0) };
}

function ZoomBar({ view, onChange }: { view: TlView; onChange: (v: TlView) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ mode: 'pan' | 'left' | 'right'; originX: number; origin: TlView } | null>(
    null,
  );

  const fracOf = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const begin = (mode: 'pan' | 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // 捕获到轨道：之后 move/up 都派发到轨道，手柄拖出窗口也不丢。
    trackRef.current?.setPointerCapture(event.pointerId);
    drag.current = { mode, originX: fracOf(event.clientX), origin: view };
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const x = fracOf(event.clientX);
    if (d.mode === 'pan') {
      onChange(clampView({ start: d.origin.start + (x - d.originX), span: d.origin.span }));
    } else if (d.mode === 'left') {
      const right = d.origin.start + d.origin.span;
      const start = Math.min(Math.max(0, x), right - MIN_SPAN);
      onChange(clampView({ start, span: right - start }));
    } else {
      const end = Math.min(1, Math.max(x, d.origin.start + MIN_SPAN));
      onChange(clampView({ start: d.origin.start, span: end - d.origin.start }));
    }
  };

  const endDrag = () => {
    drag.current = null;
  };

  /** 以窗口中心为锚缩放。 */
  const zoomBy = (factor: number) => {
    const center = view.start + view.span / 2;
    const span = view.span * factor;
    onChange(clampView({ start: center - span / 2, span }));
  };

  return (
    <div className="ph-zoom">
      <div
        ref={trackRef}
        className="ph-zoom-track"
        role="slider"
        aria-label="时间线缩放与平移"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.start * 100)}
        onPointerMove={move}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onChange(FULL_VIEW)}
        title="拖动窗口平移 · 拖两端手柄缩放 · 双击复位"
      >
        <div
          className="ph-zoom-window"
          style={{ left: `${view.start * 100}%`, width: `${view.span * 100}%` }}
          onPointerDown={begin('pan')}
        >
          <span className="ph-zoom-handle ph-zoom-handle-l" onPointerDown={begin('left')} />
          <span className="ph-zoom-handle ph-zoom-handle-r" onPointerDown={begin('right')} />
        </div>
      </div>
      <button
        type="button"
        className="ph-zoom-btn"
        onClick={() => zoomBy(1.5)}
        disabled={view.span >= 1}
        title="缩小（看更大范围）"
        aria-label="缩小时间范围"
      >
        <Minus size={11} />
      </button>
      <button
        type="button"
        className="ph-zoom-btn"
        onClick={() => zoomBy(1 / 1.5)}
        disabled={view.span <= MIN_SPAN}
        title="放大（看更细粒度）"
        aria-label="放大时间范围"
      >
        <Plus size={11} />
      </button>
      {view.span < 0.999 && (
        <span className="ph-zoom-level">{(1 / view.span).toFixed(1)}×</span>
      )}
    </div>
  );
}

/** 泳道刻度线的竖直网格（25/50/75%）。 */
function Gridlines() {
  return (
    <>
      {[25, 50, 75].map((p) => (
        <span key={p} className="ph-tl-grid" style={{ left: `${p}%` }} aria-hidden />
      ))}
    </>
  );
}

/** 泳道行高：段高 14 + 行距 3。 */
const LANE_ROW_H = 17;

function RoundTimeline({
  detail,
  highlightKey,
  pinnedKey,
  onHover,
  onJump,
}: {
  detail: AiTraceDetail;
  highlightKey: string | null;
  pinnedKey: string | null;
  onHover: (key: string | null) => void;
  onJump: (key: string) => void;
}) {
  const lanes = useMemo(() => buildLanes(detail), [detail]);
  const [view, setView] = useState<TlView>(FULL_VIEW);
  const [legendHover, setLegendHover] = useState<SegKind | null>(null);

  const present = useMemo(() => {
    if (!lanes) return new Set<SegKind>();
    const set = new Set<SegKind>();
    for (const seg of lanes.modelSegs) set.add(seg.kind);
    for (const lane of lanes.toolLanes) {
      for (const row of lane.rows) {
        for (const seg of row) set.add(seg.ok === false ? 'fail' : 'tool');
      }
    }
    if (lanes.otherLane) set.add('other');
    return set;
  }, [lanes]);

  // 全部事件都缺时间戳（旧 trace）：回退到等比时间线，不报错。
  if (!lanes) {
    return (
      <FallbackTimeline
        detail={detail}
        highlightKey={highlightKey}
        pinnedKey={pinnedKey}
        onHover={onHover}
        onJump={onJump}
      />
    );
  }

  const activeKey = pinnedKey ?? highlightKey;

  /** 淡出判定：图例悬停按类别淡出；行联动按 key 淡出（PenguinHarness 同规：绝不加外框）。 */
  const dimmed = (segKey: string, kind: SegKind): boolean => {
    if (legendHover) return kind !== legendHover;
    if (activeKey) return segKey !== activeKey;
    return false;
  };

  const renderBar = (
    seg: { key: string; startMs: number; endMs: number; title: string },
    kind: SegKind,
    extraClass: string,
    rowIndex = 0,
  ) => {
    const pos = place(view, lanes.t0, lanes.totalMs, seg.startMs, seg.endMs);
    if (!pos) return null;
    const className = [
      'ph-bar',
      `ph-bar-${kind === 'fail' ? 'tool' : kind}`,
      extraClass,
      dimmed(seg.key, kind) ? 'ph-bar-dim' : '',
      activeKey === seg.key ? 'ph-bar-on' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <button
        key={`${seg.key}-${kind}-${seg.startMs}`}
        type="button"
        className={className}
        style={{ left: `${pos.left}%`, width: `${pos.width}%`, top: 3 + rowIndex * LANE_ROW_H }}
        title={`${seg.title} · 点击定位到对应事件`}
        aria-label={seg.title}
        onMouseEnter={() => onHover(seg.key)}
        onMouseLeave={() => onHover(null)}
        onClick={() => onJump(seg.key)}
      />
    );
  };

  return (
    <div className="ph-tl">
      <div className="ph-tl-head">
        <span className="ph-tl-corner" aria-hidden />
        <div className="ph-tl-ticks" aria-hidden>
          {[0, 25, 50, 75, 100].map((p) => (
            <span key={p} style={{ left: `${p}%` }}>
              {humanMs((view.start + (p / 100) * view.span) * lanes.totalMs)}
            </span>
          ))}
        </div>
      </div>

      <div className="ph-tl-lanes" role="list" aria-label="本轮执行时间线（按真实时间戳铺开）">
        <div className="ph-tl-lane" role="listitem">
          <span className="ph-tl-label" title="模型（思考 / 回复 / 工具调用生成）">
            模型
          </span>
          <div className="ph-tl-track" style={{ height: LANE_ROW_H + 3 }}>
            <Gridlines />
            {lanes.modelSegs.map((seg) => renderBar(seg, seg.kind, ''))}
          </div>
        </div>

        {lanes.toolLanes.map((lane) => (
          <div className="ph-tl-lane" role="listitem" key={lane.label}>
            <span className="ph-tl-label" title={lane.label}>
              {lane.label}
            </span>
            <div
              className="ph-tl-track"
              style={{ height: lane.rows.length * LANE_ROW_H + 3 }}
            >
              <Gridlines />
              {lane.rows.map((row, ri) =>
                row.map((seg) =>
                  renderBar(
                    seg,
                    seg.ok === false ? 'fail' : 'tool',
                    seg.ok === false ? 'ph-bar-fail' : '',
                    ri,
                  ),
                ),
              )}
            </div>
          </div>
        ))}

        {lanes.otherLane && (
          <div className="ph-tl-lane" role="listitem">
            <span className="ph-tl-label" title="未归属步骤的工具">
              {lanes.otherLane.label}
            </span>
            <div
              className="ph-tl-track"
              style={{ height: lanes.otherLane.rows.length * LANE_ROW_H + 3 }}
            >
              <Gridlines />
              {lanes.otherLane.rows.map((row, ri) =>
                row.map((seg) => renderBar(seg, 'other', '', ri)),
              )}
            </div>
          </div>
        )}
      </div>

      <div className="ph-tl-foot">
        <div className="ph-legend">
          {LEGEND_ITEMS.filter((item) => present.has(item.kind)).map((item) => (
            <span
              key={item.kind}
              className={`ph-legend-item${
                legendHover && legendHover !== item.kind ? ' ph-legend-dim' : ''
              }`}
              title={item.title ?? item.label}
              onMouseEnter={() => setLegendHover(item.kind)}
              onMouseLeave={() => setLegendHover(null)}
            >
              <i style={{ background: SEG_COLOR[item.kind] }} />
              {item.label}
            </span>
          ))}
        </div>
        <ZoomBar view={view} onChange={setView} />
      </div>
    </div>
  );
}

/* ----- 等比时间线（旧 trace 无时间戳时的回退） ----- */

interface FallbackSeg {
  key: string;
  kind: 'model' | 'tool' | 'orphan';
  label: string;
  ms: number | null;
  ok: boolean | null;
}

function buildFallback(detail: AiTraceDetail): FallbackSeg[] {
  const segs: FallbackSeg[] = [];
  for (const step of detail.steps) {
    const ttft =
      step.time_to_first_token_ms != null ? `（首 token ${humanMs(step.time_to_first_token_ms)}）` : '';
    segs.push({
      key: `s-${step.step_index}`,
      kind: 'model',
      label: `步骤 ${step.step_index} · 模型 ${step.duration_ms != null ? humanMs(step.duration_ms) : '—'}${ttft}`,
      ms: step.duration_ms,
      ok: null,
    });
    step.tools.forEach((tool, index) => {
      const status = tool.success === true ? ' ✓' : tool.success === false ? ' ✗' : '';
      segs.push({
        key: `t-${step.step_index}-${index}`,
        kind: 'tool',
        label: `${tool.name}${status} ${tool.duration_ms != null ? humanMs(tool.duration_ms) : '—'}`,
        ms: tool.duration_ms,
        ok: tool.success,
      });
    });
  }
  (detail.orphan_tools ?? []).forEach((tool, index) => {
    const status = tool.success === true ? ' ✓' : tool.success === false ? ' ✗' : '';
    segs.push({
      key: `o-${index}`,
      kind: 'orphan',
      label: `（未归属步骤）${tool.name}${status} ${tool.duration_ms != null ? humanMs(tool.duration_ms) : '—'}`,
      ms: tool.duration_ms,
      ok: tool.success,
    });
  });
  return segs;
}

/** 耗时未知段的兜底宽度基数：给个可点击的最小占比。 */
const FALLBACK_MS = 60;

function FallbackTimeline({
  detail,
  highlightKey,
  pinnedKey,
  onHover,
  onJump,
}: {
  detail: AiTraceDetail;
  highlightKey: string | null;
  pinnedKey: string | null;
  onHover: (key: string | null) => void;
  onJump: (key: string) => void;
}) {
  const segs = useMemo(() => buildFallback(detail), [detail]);
  if (segs.length === 0) return null;
  return (
    <div
      className="ph-timeline"
      role="list"
      aria-label="本轮执行时间线（旧 trace 无时间戳，宽度与耗时成正比）"
      title="此轮为旧版 trace，无精确时间戳，按耗时等比铺开"
    >
      {segs.map((seg) => {
        const className = [
          'ph-seg',
          `ph-seg-${seg.kind}`,
          seg.kind === 'tool' || seg.kind === 'orphan'
            ? seg.ok === true
              ? 'ph-seg-ok'
              : seg.ok === false
                ? 'ph-seg-fail'
                : ''
            : '',
          seg.key === highlightKey || seg.key === pinnedKey ? 'ph-seg-active' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={seg.key}
            type="button"
            role="listitem"
            className={className}
            style={{ flexGrow: seg.ms != null && seg.ms > 0 ? seg.ms : FALLBACK_MS }}
            title={`${seg.label} · 点击定位到对应事件`}
            aria-label={seg.label}
            onMouseEnter={() => onHover(seg.key)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onJump(seg.key)}
          />
        );
      })}
    </div>
  );
}

/* ---------- 事件流（仿 PenguinHarness trace-event-row） ---------- */

type EvTone = 'brand' | 'gray' | 'amber' | 'green' | 'red' | 'sky' | 'violet';

type EvBody =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string; error?: boolean }
  | { kind: 'meta'; rows: [string, string][] }
  | { kind: 'usage'; usage: AiTraceStepUsage };

interface TraceEvent {
  rowKey: string;
  /** 与泳道段联动的 key（s-N / t-N-j / o-j）；无则此行不参与联动。 */
  segKey: string | null;
  badge: string;
  tone: EvTone;
  icon: string;
  toolName?: string;
  ts: number | null;
  summary: string;
  body: EvBody | null;
}

/** 把一轮 detail 拍平成事件流：请求开始 → 模型回复 → 工具调用/结果对 → 用量 → 请求结束。 */
function buildEvents(detail: AiTraceDetail): TraceEvent[] {
  const events: TraceEvent[] = [];

  if (detail.user_input) {
    events.push({
      rowKey: 'ev-user',
      segKey: null,
      badge: '用户',
      tone: 'brand',
      icon: EVENT_ICON.user,
      ts: tsOf(detail.started_at),
      summary: firstLine(detail.user_input),
      body: { kind: 'markdown', text: detail.user_input },
    });
  }

  for (const step of detail.steps) {
    const sKey = `s-${step.step_index}`;
    const start = tsOf(step.started_at);
    const end = tsOf(step.ended_at);

    const metaRows: [string, string][] = [];
    if (step.duration_ms != null) metaRows.push(['耗时', humanMs(step.duration_ms)]);
    if (step.time_to_first_token_ms != null)
      metaRows.push(['首 token', humanMs(step.time_to_first_token_ms)]);
    events.push({
      rowKey: `ev-${sKey}-begin`,
      segKey: sKey,
      badge: '请求开始',
      tone: 'gray',
      icon: EVENT_ICON.request_begin,
      ts: start,
      summary: `步骤 ${step.step_index} · 模型请求`,
      body: metaRows.length > 0 ? { kind: 'meta', rows: metaRows } : null,
    });

    if (step.thinking_text) {
      events.push({
        rowKey: `ev-${sKey}-think`,
        segKey: sKey,
        badge: '思考',
        tone: 'violet',
        icon: EVENT_ICON.thinking,
        ts: start,
        summary: firstLine(step.thinking_text),
        body: { kind: 'markdown', text: step.thinking_text },
      });
    }

    if (step.model_text) {
      events.push({
        rowKey: `ev-${sKey}-text`,
        segKey: sKey,
        badge: '模型回复',
        tone: 'sky',
        icon: EVENT_ICON.text,
        ts: start,
        summary: firstLine(step.model_text),
        body: { kind: 'markdown', text: step.model_text },
      });
    }

    step.tools.forEach((tool, index) => {
      const tKey = `t-${step.step_index}-${index}`;
      const failed = tool.success === false || Boolean(tool.error);
      events.push({
        rowKey: `ev-${tKey}-call`,
        segKey: tKey,
        badge: '工具调用',
        tone: 'amber',
        icon: EVENT_ICON.tool_call,
        toolName: tool.name,
        ts: tsOf(tool.started_at),
        summary: firstLine(tool.input_preview) || tool.name,
        body: tool.input_preview ? { kind: 'code', text: tool.input_preview } : null,
      });
      events.push({
        rowKey: `ev-${tKey}-out`,
        segKey: tKey,
        badge: '工具结果',
        tone: failed ? 'red' : 'green',
        icon: EVENT_ICON.tool_call_output,
        toolName: tool.name,
        ts: tsOf(tool.ended_at),
        summary:
          firstLine(tool.error ?? tool.output_preview) ||
          (tool.success === true ? '完成' : '—'),
        body:
          tool.error ?? tool.output_preview
            ? { kind: 'code', text: (tool.error ?? tool.output_preview)!, error: failed }
            : null,
      });
    });

    if (step.usage) {
      const usage = step.usage;
      events.push({
        rowKey: `ev-${sKey}-usage`,
        segKey: sKey,
        badge: '用量',
        tone: 'gray',
        icon: EVENT_ICON.token_usage,
        ts: end,
        summary:
          `输入 ${formatTokens(usage.inputTokens ?? 0)}` +
          (usage.inputDetails?.cacheRead
            ? `（缓存 ${formatTokens(usage.inputDetails.cacheRead)}）`
            : '') +
          ` · 输出 ${formatTokens(usage.outputTokens ?? 0)}`,
        body: { kind: 'usage', usage },
      });
    }

    events.push({
      rowKey: `ev-${sKey}-end`,
      segKey: sKey,
      badge: '请求结束',
      tone: 'gray',
      icon: EVENT_ICON.request_end,
      ts: end,
      summary: `finish_reason=${step.finish_reason ?? '—'}`,
      body: step.finish_reason
        ? { kind: 'meta', rows: [['结束原因', step.finish_reason]] }
        : null,
    });
  }

  (detail.orphan_tools ?? []).forEach((tool, index) => {
    const oKey = `o-${index}`;
    const failed = tool.success === false || Boolean(tool.error);
    events.push({
      rowKey: `ev-${oKey}-call`,
      segKey: oKey,
      badge: '工具调用',
      tone: 'amber',
      icon: EVENT_ICON.tool_call,
      toolName: tool.name,
      ts: tsOf(tool.started_at),
      summary: `（未归属步骤）${firstLine(tool.input_preview) || tool.name}`,
      body: tool.input_preview ? { kind: 'code', text: tool.input_preview } : null,
    });
    events.push({
      rowKey: `ev-${oKey}-out`,
      segKey: oKey,
      badge: '工具结果',
      tone: failed ? 'red' : 'green',
      icon: EVENT_ICON.tool_call_output,
      toolName: tool.name,
      ts: tsOf(tool.ended_at),
      summary:
        firstLine(tool.error ?? tool.output_preview) || (tool.success === true ? '完成' : '—'),
      body:
        tool.error ?? tool.output_preview
          ? { kind: 'code', text: (tool.error ?? tool.output_preview)!, error: failed }
          : null,
    });
  });

  if (detail.final_answer) {
    events.push({
      rowKey: 'ev-final',
      segKey: null,
      badge: '最终回答',
      tone: 'brand',
      icon: EVENT_ICON.final,
      ts: tsOf(detail.captured_at),
      summary: firstLine(detail.final_answer),
      body: { kind: 'markdown', text: detail.final_answer },
    });
  }

  return events;
}

function UsageTable({ usage }: { usage: AiTraceStepUsage }) {
  const rows: [string, string][] = [];
  if (usage.inputDetails?.cacheRead != null)
    rows.push(['缓存读取', formatTokens(usage.inputDetails.cacheRead)]);
  if (usage.inputDetails?.text != null)
    rows.push(['输入（文本）', formatTokens(usage.inputDetails.text)]);
  if (usage.inputTokens != null) rows.push(['输入合计', formatTokens(usage.inputTokens)]);
  if (usage.outputDetails?.reasoning != null)
    rows.push(['输出（推理）', formatTokens(usage.outputDetails.reasoning)]);
  if (usage.outputDetails?.text != null)
    rows.push(['输出（文本）', formatTokens(usage.outputDetails.text)]);
  if (usage.outputTokens != null) rows.push(['输出合计', formatTokens(usage.outputTokens)]);
  return (
    <div className="ph-ev-usage">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function EventBody({ body }: { body: EvBody }) {
  switch (body.kind) {
    case 'markdown':
      return <MarkdownContent content={body.text} />;
    case 'code':
      return <pre className={`ph-ev-code${body.error ? ' ph-ev-code-err' : ''}`}>{body.text}</pre>;
    case 'meta':
      return (
        <dl className="ph-ev-meta">
          {body.rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'usage':
      return <UsageTable usage={body.usage} />;
  }
}

function EventRow({
  ev,
  open,
  active,
  onToggle,
  onHover,
}: {
  ev: TraceEvent;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onHover: (key: string | null) => void;
}) {
  const ToolGlyph = ev.toolName ? toolIcon(ev.toolName) : null;
  return (
    <div
      className={`ph-ev${active ? ' ph-row-active' : ''}`}
      data-trace-row={ev.segKey ?? undefined}
      onMouseEnter={() => ev.segKey && onHover(ev.segKey)}
      onMouseLeave={() => onHover(null)}
    >
      <button type="button" className="ph-ev-head" onClick={onToggle} aria-expanded={open}>
        <span className="ph-ev-time">{ev.ts != null ? fmtClock(ev.ts) : '—'}</span>
        <Glyph d={ev.icon} />
        <span className={`ph-ev-badge ph-tone-${ev.tone}`}>{ev.badge}</span>
        {ToolGlyph && (
          <span className="ph-ev-tool-icon" title={ev.toolName}>
            <ToolGlyph size={12} aria-hidden />
          </span>
        )}
        <span className="ph-ev-sum">{ev.summary}</span>
        {ev.body && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && ev.body && (
        <div className="ph-ev-body">
          <EventBody body={ev.body} />
        </div>
      )}
    </div>
  );
}

/* ---------- 单轮卡片 ---------- */

/** 点击时间线段后，目标行高亮钉住的时长。 */
const PIN_MS = 2500;

/** 时间线事件卡片：编排事实（协查发起/回执、兜底绑定、分析轮跳过等），不是模型轮。 */
function EventCard({
  summary,
  detail,
  detailError,
  open,
  onToggle,
}: {
  summary: AiTraceSummary;
  detail: AiTimelineEventDetail | null;
  detailError: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="ai-trace-item ph-event">
      <button type="button" className="ai-trace-item-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Activity size={13} aria-hidden />
        <time>{formatDate(summary.ts)}</time>
        <span className="ph-event-title">{summary.title ?? summary.event_kind ?? '系统事件'}</span>
      </button>
      {open && (
        <div className="ph-round-body">
          {detailError && <div className="ai-trace-error">加载失败：{detailError}</div>}
          {!detail && !detailError && <div className="ai-trace-loading">加载中…</div>}
          {detail && (
            <div className="ph-event-body">
              <div className="ph-chips">
                <StatChip label="事件" value={detail.kind} title="事件种类" />
              </div>
              {detail.detail && (
                <div className="ph-event-detail">
                  <MarkdownContent content={detail.detail} />
                </div>
              )}
              {detail.data && Object.keys(detail.data).length > 0 && (
                <dl className="ph-event-data">
                  {Object.entries(detail.data).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoundCard({
  summary,
  detail,
  detailError,
  open,
  onToggle,
  contextWindow,
}: {
  summary: AiTraceSummary;
  detail: AiTraceDetail | null;
  detailError: string | null;
  open: boolean;
  onToggle: () => void;
  contextWindow?: number;
}) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pinTimer.current) clearTimeout(pinTimer.current);
    },
    [],
  );

  const stats = detail ? roundStats(detail) : null;
  const events = useMemo(() => (detail ? buildEvents(detail) : []), [detail]);
  const activeKey = pinnedKey ?? hoverKey;

  /** 点击时间线段：滚动到对应事件行并钉住高亮，鼠标移开也不消失。 */
  const jumpTo = (key: string) => {
    setPinnedKey(key);
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-trace-row="${key}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = setTimeout(() => setPinnedKey(null), PIN_MS);
  };

  const toggleRow = (key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const contextPct =
    stats?.contextTokens != null && contextWindow
      ? Math.min(100, Math.round((stats.contextTokens / contextWindow) * 100))
      : null;

  return (
    <div ref={rootRef} className="ai-trace-item ph-round">
      <button type="button" className="ai-trace-item-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <time>{formatDate(summary.ts)}</time>
        {summary.summary && (
          <span className="ai-trace-item-meta">
            {summary.summary.steps ?? 0} 步 · {summary.summary.tool_calls ?? 0} 次工具
            {summary.summary.duration_ms != null && ` · ${humanMs(summary.summary.duration_ms)}`}
          </span>
        )}
      </button>

      {open && (
        <div className="ph-round-body">
          {detailError && <div className="ai-trace-error">加载失败：{detailError}</div>}
          {!detail && !detailError && <div className="ai-trace-loading">加载中…</div>}

          {detail && stats && (
            <>
              {/* 本轮统计：工具数 / 输入（缓存命中）/ 输出 / 耗时（模型·工具拆分）/ TPS */}
              <div className="ph-chips">
                <StatChip label="工具" value={String(stats.toolCalls)} title="本轮工具调用次数" />
                <StatChip
                  label="↑输入"
                  value={
                    formatTokens(stats.inputTokens) +
                    (stats.cacheReadTokens > 0
                      ? `（◎${formatTokens(stats.cacheReadTokens)} ${formatPercent(
                          hitRateOf(stats.inputTokens, stats.cacheReadTokens),
                        )}）`
                      : '')
                  }
                  title={`本轮输入 tokens；◎为缓存命中部分，命中率 ${formatPercent(
                    hitRateOf(stats.inputTokens, stats.cacheReadTokens),
                  )}`}
                />
                <StatChip label="↓输出" value={formatTokens(stats.outputTokens)} title="本轮输出 tokens" />
                <StatChip
                  label="耗时"
                  value={humanMs(stats.modelMs + stats.toolMs)}
                  title={`模型 ${humanMs(stats.modelMs)} · 工具 ${humanMs(stats.toolMs)}`}
                />
                <StatChip
                  label="TPS"
                  value={tpsOf(stats.outputTokens, stats.modelMs)}
                  title="输出 tokens ÷ 模型生成耗时"
                />
                {contextPct != null && contextWindow != null && stats.contextTokens != null && (
                  <span
                    className="ph-ctx"
                    title={`上下文快照 ${formatTokens(stats.contextTokens)} / ${formatTokens(
                      contextWindow,
                    )}（${contextPct}%）`}
                  >
                    <em>上下文</em>
                    <span className="ph-ctx-bar">
                      <span style={{ width: `${contextPct}%` }} />
                    </span>
                    {contextPct}%
                  </span>
                )}
              </div>

              <RoundTimeline
                detail={detail}
                highlightKey={hoverKey}
                pinnedKey={pinnedKey}
                onHover={setHoverKey}
                onJump={jumpTo}
              />

              <div className="ph-events" aria-label="本轮事件流">
                {events.map((ev) => (
                  <EventRow
                    key={ev.rowKey}
                    ev={ev}
                    open={openRows.has(ev.rowKey)}
                    active={ev.segKey != null && ev.segKey === activeKey}
                    onToggle={() => toggleRow(ev.rowKey)}
                    onHover={setHoverKey}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 面板主体 ---------- */

/** PenguinHarness 右侧边栏：读取后端落盘的每轮 trace，观测 AI 轨迹（思考 / 工具 / 耗时 / token）。 */
export function PenguinHarnessPanel({
  conversationId,
  contextWindow,
  onClose,
}: {
  conversationId: string;
  /** 会话上下文窗口（用于每轮的上下文用量条）；未知则不显示。 */
  contextWindow?: number;
  onClose: () => void;
}) {
  const [traces, setTraces] = useState<AiTraceSummary[] | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, AiTraceOrEventDetail>>(new Map());
  const [detailErrors, setDetailErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [openTraceId, setOpenTraceId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = () => {
    setError(null);
    api
      .listAiTraces(conversationId)
      .then((list) => {
        setTraces(list);
        // 列表到达后预取全部轮次详情：全局汇总、统计 chips 与时间线都依赖详情。
        // 逐轮渐进填充，失败的轮次单独记录，不拖垮整个面板。
        setDetails(new Map());
        setDetailErrors(new Map());
        for (const trace of list) {
          api
            .getAiTrace(conversationId, trace.trace_id)
            .then((detail) => {
              setDetails((prev) => new Map(prev).set(trace.trace_id, detail));
            })
            .catch((err: Error) => {
              setDetailErrors((prev) => new Map(prev).set(trace.trace_id, err.message));
            });
        }
      })
      .catch((err: Error) => setError(err.message));
  };

  /** 一键导出全部轮次（用已预取的详情整包下载），用于线下/线上问题排查。 */
  const exportAll = async (format: 'json' | 'md') => {
    if (!traces?.length || exporting) return;
    setExporting(true);
    setError(null);
    try {
      // 个别轮次详情可能还在加载或加载失败：导出以最新数据为准，等全部 settle。
      const settled = await Promise.all(
        traces.map((trace) => api.getAiTrace(conversationId, trace.trace_id)),
      );
      const entries = traces.map((summary, index) => ({ summary, detail: settled[index] }));
      const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
      if (format === 'json') {
        downloadText(`ai-traces-${conversationId}-${stamp}.json`, JSON.stringify(entries, null, 2), 'application/json');
      } else {
        downloadText(`ai-traces-${conversationId}-${stamp}.md`, tracesToMarkdown(conversationId, entries), 'text/markdown');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  useEffect(load, [conversationId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 全局汇总：只统计详情已加载的轮次，数值随加载进度收敛（与 PenguinHarness 的全文件口径一致）。 */
  const globalStats = useMemo(() => {
    const acc = {
      rounds: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      modelMs: 0,
      toolMs: 0,
    };
    for (const detail of details.values()) {
      // 时间线事件不是模型轮，不参与 token/耗时统计。
      if (isTimelineEventDetail(detail)) continue;
      const s = roundStats(detail);
      acc.rounds += 1;
      acc.toolCalls += s.toolCalls;
      acc.inputTokens += s.inputTokens;
      acc.cacheReadTokens += s.cacheReadTokens;
      acc.outputTokens += s.outputTokens;
      acc.modelMs += s.modelMs;
      acc.toolMs += s.toolMs;
    }
    return acc;
  }, [details]);

  const allLoaded = traces != null && details.size + detailErrors.size >= traces.length;

  /** 模型轮次数（时间线事件不计入）。 */
  const roundCount = traces?.filter((trace) => trace.entry_type !== 'event').length ?? 0;

  return (
    <aside
      className="penguin-harness-panel"
      role="complementary"
      aria-label="PenguinHarness · AI 轨迹观测"
      aria-labelledby="penguin-harness-title"
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">PENGUINHARNESS</span>
          <h2 id="penguin-harness-title">AI 轨迹观测</h2>
        </div>
        <div className="ai-trace-header-actions">
          <button
            type="button"
            className="icon-button light"
            onClick={() => void exportAll('md')}
            disabled={exporting || !traces?.length}
            title="一键导出全部轮次为文本（便于分享排查）"
            aria-label="导出 Markdown"
          >
            <FileText size={16} />
          </button>
          <button
            type="button"
            className="icon-button light"
            onClick={() => void exportAll('json')}
            disabled={exporting || !traces?.length}
            title="一键导出全部轮次为 JSON（原始数据）"
            aria-label="导出 JSON"
          >
            <FileJson size={16} />
          </button>
          <button
            type="button"
            className="icon-button light"
            onClick={load}
            title="刷新"
            aria-label="刷新 trace 列表"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="icon-button light"
            onClick={onClose}
            title="关闭"
            aria-label="关闭 PenguinHarness"
          >
            <X size={19} />
          </button>
        </div>
      </header>

      <div className="ai-trace-body">
        {error && <div className="ai-trace-error">加载失败：{error}</div>}
        {traces && traces.length === 0 && (
          <div className="ai-trace-empty">
            暂无落盘 trace（本对话还没跑过诊断，或可观测目录未配置）。
          </div>
        )}

        {traces != null && traces.length > 0 && (
          <>
            {/* 全局汇总：计数 / token 用量（含缓存命中）/ 耗时·TPS 三组，
                与 PenguinHarness Trace 视图的全文件汇总同口径。 */}
            <section className="ph-summary" aria-label="全局汇总">
              <div className="ph-summary-grid">
                <div>
                  <SummaryRow label="轮次" value={String(roundCount)} />
                  <SummaryRow label="工具调用" value={String(globalStats.toolCalls)} />
                </div>
                <div>
                  <SummaryRow label="输入" value={formatTokens(globalStats.inputTokens)} />
                  <SummaryRow
                    label="缓存命中"
                    value={`${formatTokens(globalStats.cacheReadTokens)} · ${formatPercent(
                      hitRateOf(globalStats.inputTokens, globalStats.cacheReadTokens),
                    )}`}
                  />
                  <SummaryRow label="输出" value={formatTokens(globalStats.outputTokens)} />
                </div>
                <div>
                  <SummaryRow
                    label="耗时"
                    value={`${humanMs(globalStats.modelMs + globalStats.toolMs)}（模型 ${humanMs(
                      globalStats.modelMs,
                    )} · 工具 ${humanMs(globalStats.toolMs)}）`}
                  />
                  <SummaryRow label="TPS" value={tpsOf(globalStats.outputTokens, globalStats.modelMs)} />
                </div>
              </div>
              {!allLoaded && (
                <div className="ph-summary-note">
                  正在加载各轮详情（{details.size}/{traces.length}），汇总随加载收敛…
                </div>
              )}
            </section>

            <div className="ai-trace-toolbar">会话时间线（最新在前）：模型轮次与系统事件，点击展开</div>
            {traces.map((trace) => {
              const detail = details.get(trace.trace_id) ?? null;
              if (trace.entry_type === 'event') {
                return (
                  <EventCard
                    key={trace.trace_id}
                    summary={trace}
                    detail={detail && isTimelineEventDetail(detail) ? detail : null}
                    detailError={detailErrors.get(trace.trace_id) ?? null}
                    open={openTraceId === trace.trace_id}
                    onToggle={() => setOpenTraceId(openTraceId === trace.trace_id ? null : trace.trace_id)}
                  />
                );
              }
              return (
                <RoundCard
                  key={trace.trace_id}
                  summary={trace}
                  detail={detail && !isTimelineEventDetail(detail) ? detail : null}
                  detailError={detailErrors.get(trace.trace_id) ?? null}
                  open={openTraceId === trace.trace_id}
                  onToggle={() => setOpenTraceId(openTraceId === trace.trace_id ? null : trace.trace_id)}
                  contextWindow={contextWindow}
                />
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}
