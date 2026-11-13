import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  FileSearch,
  Gauge,
  MapPin,
  SearchCheck,
  ShieldAlert,
} from 'lucide-react';
import { severityLabel } from '../../format';
import type { DiagnosticReport } from '../../types';

const VERDICT_LABELS = {
  located: '已定位',
  probable: '可能定位',
  insufficient_evidence: '证据不足',
  tool_error: '工具异常',
} as const;

function percent(value: number): number {
  const normalized = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

/** 嵌入聊天消息的结构化诊断报告卡片：已通过服务端证据校验。 */
export function ReportCard({ report }: { report: DiagnosticReport }) {
  const externalClaims = report.joint_assessment?.unverified_claims ?? [];
  return (
    <div className={`report-card verdict-border-${report.verdict}`} aria-label="诊断报告">
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
            {VERDICT_LABELS[report.verdict]}
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

      {report.root_cause_candidates.length > 0 && (
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
      )}

      {(externalClaims.length > 0 || (report.external_findings?.length ?? 0) > 0) && (
        <section className="report-section missing-information">
          <div className="report-section-title">
            <AlertTriangle size={16} />
            <h3>外部候选原因（未验证）</h3>
          </div>
          <ul>
            {externalClaims.map((item, index) => (
              <li key={`unverified-${index}`}>{item}</li>
            ))}
            {externalClaims.length === 0 && report.external_findings?.map((finding, index) => (
              <li key={`external-${finding.consultation_id}-${index}`}>
                <strong>外部 Agent：</strong>{finding.text}
                {finding.truncated ? '（远端输出不完整）' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.evidence.length > 0 && (
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
                {evidence.location && (
                  <span className="evidence-location">{evidence.location}</span>
                )}
                <p>{evidence.excerpt}</p>
                <small>{evidence.supports}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {report.checks_performed.length > 0 && (
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
      )}

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
    </div>
  );
}
