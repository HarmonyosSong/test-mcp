import {
  AlertTriangle,
  Ban,
  Cable,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  FileSearch,
  Gauge,
  Layers3,
  LoaderCircle,
  MapPin,
  Radar,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { formatDate, severityLabel } from '../format';
import type { DiagnosticCase, MetaResponse } from '../types';

interface DiagnosisPanelProps {
  diagnosticCase: DiagnosticCase | null;
  meta: MetaResponse;
}

function percent(value: number): number {
  const normalized = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function CapabilitySection({ meta }: { meta: MetaResponse }) {
  return (
    <section className="capability-section report-section">
      <div className="report-section-title">
        <Layers3 size={16} />
        <h3>本次可用能力</h3>
      </div>
      <div className="capability-group">
        <div className="capability-label">
          <Wrench size={14} />
          Skills
        </div>
        <div className="capability-list">
          {meta.skills.length ? (
            meta.skills.map((skill) => (
              <span key={`${skill.name}-${skill.stage}`} title={skill.description}>
                {skill.name}
                <small>{skill.stage}</small>
              </span>
            ))
          ) : (
            <span className="capability-empty">未返回 Skill 元数据</span>
          )}
        </div>
      </div>
      <div className="capability-group">
        <div className="capability-label">
          <Cable size={14} />
          MCP
        </div>
        <div className="capability-list">
          {meta.mcp_tools.length ? (
            meta.mcp_tools.map((tool) => (
              <span key={tool}>
                {tool}
              </span>
            ))
          ) : (
            <span className="capability-empty">未返回 MCP 工具元数据</span>
          )}
        </div>
      </div>
      <div className="capability-group">
        <div className="capability-label">
          <ShieldCheck size={14} />
          约束
        </div>
        <div className="capability-list constraints-list">
          {meta.constraints.map((constraint) => (
            <span key={constraint}>{constraint}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function DiagnosisPanel({ diagnosticCase, meta }: DiagnosisPanelProps) {
  if (!diagnosticCase) {
    return (
      <aside className="pane diagnosis-pane empty-pane">
        <Radar size={30} />
        <h2>等待诊断上下文</h2>
        <p>选择案例后，这里会汇总证据与最终诊断。</p>
      </aside>
    );
  }

  const report = diagnosticCase.report;
  const verdictLabels = {
    located: '已定位',
    probable: '可能定位',
    insufficient_evidence: '证据不足',
    tool_error: '工具异常',
  } as const;

  return (
    <aside className="pane diagnosis-pane" aria-label="证据与诊断">
      <div className="pane-heading diagnosis-heading">
        <div>
          <span className="eyebrow">EVIDENCE &amp; DIAGNOSIS</span>
          <h2>证据与诊断</h2>
        </div>
        {report ? <SearchCheck size={21} /> : <Radar size={21} />}
      </div>

      <div className="diagnosis-scroll scroll-region">
        {report ? (
          <>
            <section className="diagnosis-summary">
              <div className="diagnosis-badges">
                <span className={`severity-badge severity-${report.severity.toLowerCase()}`}>
                  <ShieldAlert size={14} />
                  {severityLabel(report.severity)}风险
                </span>
                <span className="confidence-value">
                  <Gauge size={14} />
                  置信度 {percent(report.confidence)}%
                </span>
                <span className={`verdict-badge verdict-${report.verdict}`}>
                  {verdictLabels[report.verdict]}
                </span>
              </div>
              <h3>诊断结论</h3>
              <p>{report.summary}</p>
              <span className="issue-category">{report.issue_category}</span>
              <div className="confidence-track" aria-label={`置信度 ${percent(report.confidence)}%`}>
                <span style={{ width: `${percent(report.confidence)}%` }} />
              </div>
            </section>

            {report.likely_location && (
              <section className="likely-location report-section">
                <div className="report-section-title">
                  <MapPin size={16} />
                  <h3>最可能位置</h3>
                </div>
                <code>{report.likely_location}</code>
              </section>
            )}

            <section className="report-section">
              <div className="report-section-title">
                <FileSearch size={16} />
                <h3>根因假设</h3>
                <span>{report.root_cause_candidates.length}</span>
              </div>
              <div className="root-cause-list">
                {report.root_cause_candidates.map((cause, index) => (
                  <article className="root-cause" key={`${cause.title}-${index}`}>
                    <div>
                      <span>0{index + 1}</span>
                      <strong>{cause.title}</strong>
                      <small>{percent(cause.confidence)}%</small>
                    </div>
                    <p>{cause.explanation}</p>
                    {cause.evidence_ids.length > 0 && (
                      <div className="evidence-links" aria-label="关联证据">
                        {cause.evidence_ids.map((id) => (
                          <code key={id}>{id}</code>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>

            <section className="report-section">
              <div className="report-section-title">
                <SearchCheck size={16} />
                <h3>关键证据</h3>
                <span>{report.evidence.length}</span>
              </div>
              <div className="evidence-list">
                {report.evidence.map((evidence, index) => (
                  <article className="evidence-row" key={`${evidence.source}-${index}`}>
                    <div className="evidence-source-row">
                      <strong>{evidence.source}</strong>
                      <code>{evidence.id}</code>
                    </div>
                    {evidence.location && <span className="evidence-location">{evidence.location}</span>}
                    <p>{evidence.excerpt}</p>
                    <small>{evidence.supports}</small>
                  </article>
                ))}
              </div>
            </section>

            <section className="report-section">
              <div className="report-section-title">
                <ClipboardCheck size={16} />
                <h3>已执行检查</h3>
              </div>
              <ul className="check-list">
                {report.checks_performed.map((item, index) => (
                  <li key={`${item}-${index}`}>
                    <CheckCircle2 size={14} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>

            {report.ruled_out.length > 0 && (
              <section className="report-section">
                <div className="report-section-title">
                  <Ban size={16} />
                  <h3>已排除</h3>
                </div>
                <ul className="ruled-out-list">
                  {report.ruled_out.map((item, index) => (
                    <li key={`${item}-${index}`}>
                      <CheckCircle2 size={14} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {report.missing_information.length > 0 && (
              <section className="report-section missing-information">
                <div className="report-section-title">
                  <CircleHelp size={16} />
                  <h3>仍缺信息</h3>
                </div>
                <ul>
                  {report.missing_information.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </section>
            )}

            {report.limitations.length > 0 && (
              <section className="limitations report-section">
                <div className="report-section-title">
                  <AlertTriangle size={16} />
                  <h3>诊断边界</h3>
                </div>
                {report.limitations.map((item, index) => (
                  <p key={`${item}-${index}`}>{item}</p>
                ))}
              </section>
            )}

            {diagnosticCase.tool_events.length > 0 && (
              <section className="report-section mcp-audit-section">
                <div className="report-section-title">
                  <Cable size={16} />
                  <h3>MCP 调用审计</h3>
                  <span>{diagnosticCase.tool_events.length}</span>
                </div>
                <div className="tool-event-list">
                  {diagnosticCase.tool_events.map((event) => (
                    <div className={`tool-event-row tool-event-${event.status}`} key={event.id}>
                      <span className="tool-event-dot" />
                      <div>
                        <strong>{event.tool}</strong>
                        <p>{event.summary}</p>
                      </div>
                      <time>{formatDate(event.created_at)}</time>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : diagnosticCase.status === 'failed' ? (
          <section className="diagnosis-pending failed-diagnosis">
            <AlertTriangle size={28} />
            <h3>未生成诊断报告</h3>
            <p>{diagnosticCase.error || '执行过程失败，当前没有可用的诊断结论。'}</p>
          </section>
        ) : (
          <section className="diagnosis-pending">
            {diagnosticCase.status === 'running' ? (
              <LoaderCircle className="spin" size={28} />
            ) : (
              <Radar size={28} />
            )}
            <h3>{diagnosticCase.status === 'queued' ? '等待开始诊断' : '正在形成诊断'}</h3>
            <p>
              {diagnosticCase.status === 'queued'
                ? '案例已进入队列，执行器领取后将开始定位。'
                : '当前证据仍在排查中，完成闭环后生成结构化结论。'}
            </p>
            <div className="pending-evidence">
              <span>当前阶段</span>
              <strong>
                {diagnosticCase.stages.find((stage) => stage.status === 'running')?.label ||
                  diagnosticCase.stages.find((stage) => stage.status === 'pending')?.label ||
                  '等待执行'}
              </strong>
            </div>
          </section>
        )}

        <CapabilitySection meta={meta} />
      </div>
    </aside>
  );
}
