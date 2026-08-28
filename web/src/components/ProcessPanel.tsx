import {
  Check,
  Circle,
  Clock3,
  FileText,
  FolderCode,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Quote,
  X,
} from 'lucide-react';
import { caseStatusLabel, formatDate, formatDuration, stageStatusLabel } from '../format';
import type { DiagnosticCase, DiagnosticStage, StageStatus } from '../types';

interface ProcessPanelProps {
  diagnosticCase: DiagnosticCase | null;
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === 'completed') return <Check size={15} />;
  if (status === 'running') return <LoaderCircle className="spin" size={15} />;
  if (status === 'failed') return <X size={15} />;
  return <Circle size={11} />;
}

function StageCard({ stage, index }: { stage: DiagnosticStage; index: number }) {
  return (
    <article className={`stage-card stage-${stage.status}`} aria-current={stage.status === 'running'}>
      <div className="stage-rail" aria-hidden="true">
        <span className="stage-node">
          <StageIcon status={stage.status} />
        </span>
        <span className="stage-line" />
      </div>
      <div className="stage-body">
        <div className="stage-title-row">
          <div>
            <span className="stage-index">0{index + 1}</span>
            <h3>{stage.label}</h3>
          </div>
          <span className={`stage-state stage-state-${stage.status}`}>
            {stageStatusLabel(stage.status)}
          </span>
        </div>
        {stage.summary && <p className="stage-summary">{stage.summary}</p>}
        <div className="stage-timing">
          <Clock3 size={13} />
          <span>{formatDate(stage.started_at)}</span>
          {stage.started_at && (
            <span>{formatDuration(stage.started_at, stage.completed_at)}</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function ProcessPanel({ diagnosticCase }: ProcessPanelProps) {
  if (!diagnosticCase) {
    return (
      <section className="pane process-pane empty-pane">
        <FileText size={30} />
        <h2>尚未选择案例</h2>
        <p>从案例队列中选择一项查看诊断过程。</p>
      </section>
    );
  }

  const completedStages = diagnosticCase.stages.filter(
    (stage) => stage.status === 'completed',
  ).length;
  const progress = diagnosticCase.stages.length
    ? Math.round((completedStages / diagnosticCase.stages.length) * 100)
    : 0;

  return (
    <section className="pane process-pane" aria-label="诊断过程">
      <div className="case-context">
        <div className="case-context-topline">
          <span className="eyebrow">DIAGNOSTIC PROCESS</span>
          <span className={`status-badge status-${diagnosticCase.status}`}>
            {caseStatusLabel(diagnosticCase.status)}
          </span>
        </div>
        <h1>{diagnosticCase.title}</h1>
        <p>{diagnosticCase.description}</p>
        <div className="case-facts">
          {diagnosticCase.repository_name && diagnosticCase.requested_ref && (
            <span>
              <GitBranch size={14} />
              {diagnosticCase.repository_name} / {diagnosticCase.requested_ref}
            </span>
          )}
          {diagnosticCase.resolved_commit && (
            <span title={diagnosticCase.resolved_commit}>
              <GitCommitHorizontal size={14} />
              {diagnosticCase.resolved_commit.slice(0, 12)}
            </span>
          )}
          {diagnosticCase.workspace_path && !diagnosticCase.repository_name && (
            <span title={diagnosticCase.workspace_path}>
              <FolderCode size={14} />
              {diagnosticCase.workspace_path}
            </span>
          )}
          <span>
            <Clock3 size={14} />
            更新于 {formatDate(diagnosticCase.updated_at)}
          </span>
        </div>
      </div>

      <div className="process-scroll scroll-region">
        <section className="progress-overview" aria-label={`诊断进度 ${progress}%`}>
          <div className="section-title-row">
            <div>
              <span className="section-kicker">PIPELINE</span>
              <h2>诊断链路</h2>
            </div>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="stage-overview-list">
            {diagnosticCase.stages.map((stage) => (
              <span key={stage.key} className={`overview-step overview-${stage.status}`}>
                <StageIcon status={stage.status} />
                {stage.label}
              </span>
            ))}
          </div>
        </section>

        <section className="input-evidence">
          <div className="section-title-row compact">
            <div>
              <span className="section-kicker">INPUT</span>
              <h2>原始证据</h2>
            </div>
            <Quote size={18} />
          </div>
          <pre>{diagnosticCase.input_evidence || '未提供额外证据'}</pre>
        </section>

        <section className="stage-list" aria-label="阶段详情">
          {diagnosticCase.stages.map((stage, index) => (
            <StageCard key={`${stage.key}-${index}`} stage={stage} index={index} />
          ))}
        </section>

        {diagnosticCase.status === 'failed' && diagnosticCase.error && (
          <div className="case-error" role="alert">
            <X size={17} />
            <div>
              <strong>诊断执行失败</strong>
              <p>{diagnosticCase.error}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
