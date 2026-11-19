import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';

import { api } from '../../api';
import { formatDate } from '../../format';
import type { AiTraceDetail, AiTraceSummary, AiTraceStep } from '../../types';

function TraceBlock({ title, text }: { title: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div className="ai-trace-block">
      <div className="ai-trace-block-title">{title}</div>
      <pre className="ai-trace-pre">{text}</pre>
    </div>
  );
}

function StepView({ step }: { step: AiTraceStep }) {
  return (
    <div className="ai-trace-step">
      <div className="ai-trace-step-head">
        步骤 {step.step_index}
        {step.duration_ms != null && <span> · {Math.round(step.duration_ms)}ms</span>}
        {step.finish_reason && <span> · {step.finish_reason}</span>}
      </div>
      <TraceBlock title="模型输出" text={step.model_text} />
      {step.tools.map((tool, index) => (
        <div key={index} className="ai-trace-tool">
          <div className="ai-trace-tool-head">
            {tool.name}
            {tool.success === true && <span className="ai-trace-ok"> ✓</span>}
            {tool.success === false && <span className="ai-trace-fail"> ✗</span>}
            {tool.duration_ms != null && <span> · {Math.round(tool.duration_ms)}ms</span>}
          </div>
          <TraceBlock title="入参" text={tool.input_preview} />
          <TraceBlock title={tool.error ? '错误' : '返回'} text={tool.error ?? tool.output_preview} />
        </div>
      ))}
    </div>
  );
}

function TraceDetailView({ conversationId, traceId }: { conversationId: string; traceId: string }) {
  const [detail, setDetail] = useState<AiTraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAiTrace(conversationId, traceId)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, traceId]);

  if (error) return <div className="ai-trace-error">加载失败：{error}</div>;
  if (!detail) return <div className="ai-trace-loading">加载中…</div>;
  return (
    <div className="ai-trace-detail">
      <TraceBlock title="用户输入（进入模型的当轮提问）" text={detail.user_input} />
      <TraceBlock title="最终回答（模型输出）" text={detail.final_answer} />
      {detail.steps.map((step) => (
        <StepView key={step.step_index} step={step} />
      ))}
      {(detail.orphan_tools ?? []).map((tool, index) => (
        <div key={index} className="ai-trace-tool">
          <div className="ai-trace-tool-head">（未归属步骤）{tool.name}</div>
          <TraceBlock title="入参" text={tool.input_preview} />
          <TraceBlock title="返回" text={tool.output_preview} />
        </div>
      ))}
    </div>
  );
}

/** AI 输入/输出调试弹窗：读取后端落盘的每轮 trace。 */
export function AiTraceDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const [traces, setTraces] = useState<AiTraceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTraceId, setOpenTraceId] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api
      .listAiTraces(conversationId)
      .then(setTraces)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [conversationId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ai-trace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-trace-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">AI DEBUG</span>
            <h2 id="ai-trace-title">AI 输入 / 输出</h2>
          </div>
          <div className="ai-trace-header-actions">
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
              aria-label="关闭 AI 调试"
            >
              <X size={19} />
            </button>
          </div>
        </header>

        <div className="ai-trace-body">
          <div className="ai-trace-toolbar">按轮次查看（最新在前），点击展开单轮完整输入输出</div>
          {error && <div className="ai-trace-error">加载失败：{error}</div>}
          {traces && traces.length === 0 && (
            <div className="ai-trace-empty">
              暂无落盘 trace（本对话还没跑过诊断，或可观测目录未配置）。
            </div>
          )}
          {traces?.map((trace) => {
            const open = openTraceId === trace.trace_id;
            return (
              <div key={trace.trace_id} className="ai-trace-item">
                <button
                  type="button"
                  className="ai-trace-item-head"
                  onClick={() => setOpenTraceId(open ? null : trace.trace_id)}
                >
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <time>{formatDate(trace.ts)}</time>
                  {trace.summary && (
                    <span className="ai-trace-item-meta">
                      {trace.summary.steps ?? 0} 步 · {trace.summary.tool_calls ?? 0} 次工具
                      {trace.summary.duration_ms != null &&
                        ` · ${Math.round(trace.summary.duration_ms / 1000)}s`}
                    </span>
                  )}
                </button>
                {open && <TraceDetailView conversationId={conversationId} traceId={trace.trace_id} />}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
