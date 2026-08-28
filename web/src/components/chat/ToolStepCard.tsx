import {
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { ChatStep } from '../../types';

function StepIcon({ status }: { status: string }) {
  if (status === 'running') return <LoaderCircle className="spin" size={13} />;
  if (status === 'failed') return <X size={13} />;
  return <Check size={13} />;
}

/** 消息内联的工具/Skill 调用步骤卡片（可折叠展开参数与结果摘要）。 */
export function ToolStepCard({ step }: { step: ChatStep }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(step.arguments_summary || step.result_summary);

  return (
    <div className={`tool-step-card tool-step-${step.status}`}>
      <button
        type="button"
        className="tool-step-header"
        onClick={() => hasDetail && setExpanded((value) => !value)}
        aria-expanded={expanded}
        disabled={!hasDetail}
      >
        <span className="tool-step-icon">
          <StepIcon status={step.status} />
        </span>
        <Wrench size={13} aria-hidden="true" />
        <strong>{step.tool}</strong>
        <span className="tool-step-summary">{step.summary}</span>
        {step.duration_ms != null && (
          <span className="tool-step-duration">{step.duration_ms} ms</span>
        )}
        {hasDetail &&
          (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {expanded && hasDetail && (
        <div className="tool-step-detail">
          {step.arguments_summary && (
            <div className="tool-step-block">
              <span>调用参数</span>
              <pre>{step.arguments_summary}</pre>
            </div>
          )}
          {step.result_summary && (
            <div className="tool-step-block">
              <span>结果摘要</span>
              <pre>{step.result_summary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
