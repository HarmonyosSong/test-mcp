import {
  AlertTriangle,
  FolderCode,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Send,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  ConnectionState,
  CreateCaseInput,
  RepositoryBranch,
  RepositoryRecord,
} from '../types';

interface NewCaseDialogProps {
  connection: ConnectionState;
  submitting: boolean;
  error: string;
  repositories: RepositoryRecord[];
  /** 聊天「生成诊断案例」时预填的草稿 */
  initialValue?: CreateCaseInput | null;
  onClose: () => void;
  onSubmit: (input: CreateCaseInput) => void;
}

export function NewCaseDialog({
  connection,
  submitting,
  error,
  repositories,
  initialValue,
  onClose,
  onSubmit,
}: NewCaseDialogProps) {
  const [title, setTitle] = useState(initialValue?.title ?? '');
  const [description, setDescription] = useState(initialValue?.description ?? '');
  const [evidence, setEvidence] = useState(initialValue?.evidence ?? '');
  const [workspacePath, setWorkspacePath] = useState(initialValue?.workspace_path ?? '');
  const [sourceMode, setSourceMode] = useState<'repository' | 'local'>(
    initialValue?.workspace_path
      ? 'local'
      : repositories.length > 0
        ? 'repository'
        : 'local',
  );
  const [repositoryId, setRepositoryId] = useState(
    initialValue?.repository_id || repositories[0]?.id || '',
  );
  const [branch, setBranch] = useState(
    initialValue?.branch || repositories[0]?.default_branch || '',
  );
  const [branches, setBranches] = useState<RepositoryBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  useEffect(() => {
    if (sourceMode !== 'repository' || !repositoryId) return;
    let cancelled = false;
    const repository = repositories.find((item) => item.id === repositoryId);
    setBranchesLoading(true);
    setBranchError('');
    void api
      .repositoryBranches(repositoryId)
      .then((items) => {
        if (cancelled) return;
        setBranches(items);
        setBranch((current) => current || repository?.default_branch || items[0]?.name || '');
      })
      .catch((nextError) => {
        if (cancelled) return;
        setBranchError(nextError instanceof Error ? nextError.message : '分支读取失败。');
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repositories, repositoryId, sourceMode]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      evidence: evidence.trim(),
      workspace_path:
        sourceMode === 'local' ? workspacePath.trim() || undefined : undefined,
      repository_id: sourceMode === 'repository' ? repositoryId : undefined,
      branch: sourceMode === 'repository' ? branch.trim() : undefined,
    });
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        className="new-case-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-case-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">NEW DIAGNOSTIC CASE</span>
            <h2 id="new-case-title">
              {initialValue ? '从对话生成诊断案例' : '新建问题诊断'}
            </h2>
          </div>
          <button
            className="icon-button light"
            type="button"
            onClick={onClose}
            disabled={submitting}
            title="关闭"
            aria-label="关闭新建诊断窗口"
          >
            <X size={19} />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          {connection !== 'connected' && (
            <div className="dialog-connection-warning" role="status">
              <AlertTriangle size={17} />
              <span>
                {connection === 'checking'
                  ? '诊断服务仍在连接，当前暂不能提交。'
                  : '诊断服务未连接。当前为演示模式，提交不会创建案例。'}
              </span>
            </div>
          )}

          <label className="form-field">
            <span>问题标题</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：横屏返回后详情页空白"
              minLength={2}
              maxLength={120}
              required
            />
          </label>

          <label className="form-field">
            <span>问题描述</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明发生了什么、复现条件和预期行为"
              minLength={2}
              rows={4}
              required
            />
          </label>

          <label className="form-field">
            <span>现有证据 <small>可选</small></span>
            <textarea
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder="粘贴日志片段、错误码、相关文件或已排除项"
              rows={6}
            />
          </label>

          <div className="source-mode-control" role="tablist" aria-label="代码来源">
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'repository'}
              className={sourceMode === 'repository' ? 'selected' : ''}
              onClick={() => setSourceMode('repository')}
              disabled={repositories.length === 0}
            >
              <FolderGit2 size={16} />
              业务仓库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === 'local'}
              className={sourceMode === 'local' ? 'selected' : ''}
              onClick={() => setSourceMode('local')}
            >
              <FolderCode size={16} />
              本地路径
            </button>
          </div>

          {sourceMode === 'repository' ? (
            <div className="repository-source-fields">
              <label className="form-field">
                <span>业务仓库</span>
                <select
                  value={repositoryId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextRepository = repositories.find((item) => item.id === nextId);
                    setRepositoryId(nextId);
                    setBranch(nextRepository?.default_branch || '');
                    setBranches([]);
                  }}
                  required
                >
                  {repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>
                  分支
                  {branchesLoading && <small> 正在读取远端分支</small>}
                </span>
                <div className="branch-input">
                  {branchesLoading ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <GitBranch size={16} />
                  )}
                  <input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    list="repository-branches"
                    placeholder="例如：feature/student-order"
                    required
                  />
                  <datalist id="repository-branches">
                    {branches.map((item) => (
                      <option key={item.name} value={item.name} />
                    ))}
                  </datalist>
                </div>
                {branchError && <small className="field-error-text">{branchError}</small>}
              </label>
              <p className="snapshot-note">
                提交时会刷新该分支、解析实际 Commit，并创建隔离的只读快照。
              </p>
            </div>
          ) : (
            <label className="form-field path-field">
              <span>工作区路径 <small>可选</small></span>
              <div>
                <FolderCode size={16} />
                <input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="/path/to/harmony/project"
                />
              </div>
            </label>
          )}

          {error && (
            <div className="form-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          <footer className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? <span className="button-spinner" /> : <Send size={16} />}
              {submitting ? '正在提交' : '开始诊断'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
