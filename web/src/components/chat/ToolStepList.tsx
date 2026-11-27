import {
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { ChatStep } from '../../types';
import { ToolStepCard } from './ToolStepCard';
import { ToolIcon } from './toolIcons';

/** 连续相同工具折叠成组（保持时间线顺序）：a,a,a,b → [a×3] [b]。 */
function groupConsecutiveSteps(steps: ChatStep[]): ChatStep[][] {
  const groups: ChatStep[][] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last && last[0]!.tool === step.tool) last.push(step);
    else groups.push([step]);
  }
  return groups;
}

function GroupIcon({ steps }: { steps: ChatStep[] }) {
  if (steps.some((step) => step.status === 'running')) {
    return <LoaderCircle className="spin" size={13} />;
  }
  if (steps.some((step) => step.status === 'failed')) return <X size={13} />;
  return <Check size={13} />;
}

/** 相同工具的连续调用组：父级一行汇总（工具名 ×N + 末条摘要 + 累计耗时），展开看子列表。 */
function ToolStepGroup({ steps }: { steps: ChatStep[] }) {
  const running = steps.some((step) => step.status === 'running');
  const failed = steps.some((step) => step.status === 'failed');
  // 未手动操作时跟随运行态：进行中展开便于看进度，全部结束后自动收起防刷屏。
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? running;
  const totalMs = steps.reduce((sum, step) => sum + (step.duration_ms ?? 0), 0);
  const lastSummary = steps.at(-1)?.summary ?? '';

  return (
    <div
      className={`tool-step-card tool-step-group ${
        running ? 'tool-step-running' : failed ? 'tool-step-failed' : 'tool-step-completed'
      }`}
    >
      <button
        type="button"
        className="tool-step-header"
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
      >
        <span className="tool-step-icon">
          <GroupIcon steps={steps} />
        </span>
        <ToolIcon tool={steps[0]!.tool} />
        <strong>{steps[0]!.tool}</strong>
        <span className="tool-step-count">×{steps.length}</span>
        <span className="tool-step-summary">{lastSummary}</span>
        {totalMs > 0 && <span className="tool-step-duration">{totalMs} ms</span>}
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {expanded && (
        <div className="tool-step-children">
          {steps.map((step) => (
            <ToolStepCard key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 工具步骤列表：连续相同工具自动折叠成组，单独调用保持原样。 */
export function ToolStepList({ steps }: { steps: ChatStep[] }) {
  return (
    <>
      {groupConsecutiveSteps(steps).map((group) =>
        group.length === 1 ? (
          <ToolStepCard key={group[0]!.id} step={group[0]!} />
        ) : (
          <ToolStepGroup key={group[0]!.id} steps={group} />
        ),
      )}
    </>
  );
}
