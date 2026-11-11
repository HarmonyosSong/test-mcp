import {
  AlertTriangle,
  Check,
  CheckCircle2,
  GitBranch,
  GitFork,
  LoaderCircle,
  Pencil,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RepositoryRecord } from '../types';

interface RepositorySettingsDialogProps {
  repositories: RepositoryRecord[];
  onClose: () => void;
  onRegistered: (repository: RepositoryRecord) => void;
}

export function RepositorySettingsDialog({
  repositories,
  onClose,
  onRegistered,
}: RepositorySettingsDialogProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBranch, setEditingBranch] = useState('');
  const [savingBranch, setSavingBranch] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending && !savingBranch && !editingId) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pending, savingBranch, editingId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const repository = await api.registerRepository({
        name: name.trim(),
        url: url.trim(),
        default_branch: defaultBranch.trim() || undefined,
      });
      onRegistered(repository);
      setName('');
      setUrl('');
      setDefaultBranch('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '仓库登记失败。');
    } finally {
      setPending(false);
    }
  };

  const saveBranch = async (repository: RepositoryRecord) => {
    const branch = editingBranch.trim();
    if (!branch) {
      setError('默认分支不能为空。');
      return;
    }
    if (branch === repository.default_branch) {
      setEditingId(null);
      return;
    }
    setSavingBranch(true);
    setError('');
    try {
      const updated = await api.updateRepository(repository.id, { default_branch: branch });
      onRegistered(updated);
      setEditingId(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '默认分支保存失败。');
    } finally {
      setSavingBranch(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending && !savingBranch) onClose();
      }}
    >
      <section
        className="repository-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-settings-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">REPOSITORY REGISTRY</span>
            <h2 id="repository-settings-title">业务仓库</h2>
          </div>
          <button
            className="icon-button light"
            type="button"
            onClick={onClose}
            disabled={pending || savingBranch}
            title="关闭"
            aria-label="关闭仓库设置"
          >
            <X size={19} />
          </button>
        </header>

        <div className="repository-dialog-body">
          <section className="registered-repositories" aria-label="已登记仓库">
            <div className="repository-section-title">
              <GitFork size={16} />
              <strong>已登记仓库</strong>
              <span>{repositories.length}</span>
            </div>
            {repositories.length > 0 ? (
              <div className="repository-list">
                {repositories.map((repository) => (
                  <div className="repository-row" key={repository.id}>
                    <CheckCircle2 size={16} />
                    <div>
                      <strong>{repository.name}</strong>
                      <span>{repository.url}</span>
                    </div>
                    {editingId === repository.id ? (
                      <div className="repository-branch-editor">
                        <input
                          aria-label={`${repository.name} 默认分支`}
                          value={editingBranch}
                          onChange={(event) => setEditingBranch(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveBranch(repository);
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditingId(null);
                              setError('');
                            }
                          }}
                          disabled={savingBranch}
                          autoFocus
                        />
                        <button
                          className="icon-button light"
                          type="button"
                          title="校验并保存默认分支"
                          aria-label={`保存 ${repository.name} 默认分支`}
                          disabled={savingBranch}
                          onClick={() => void saveBranch(repository)}
                        >
                          {savingBranch ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                        </button>
                        <button
                          className="icon-button light"
                          type="button"
                          title="取消修改"
                          aria-label={`取消修改 ${repository.name} 默认分支`}
                          disabled={savingBranch}
                          onClick={() => { setEditingId(null); setError(''); }}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <code title="新建会话的默认分支">{repository.default_branch}</code>
                        <button
                          className="icon-button light repository-branch-edit"
                          type="button"
                          title="修改默认分支（不影响已有会话）"
                          aria-label={`修改 ${repository.name} 默认分支`}
                          disabled={pending || savingBranch}
                          onClick={() => {
                            setEditingId(repository.id);
                            setEditingBranch(repository.default_branch);
                            setError('');
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="repository-empty">尚未登记业务仓库</div>
            )}
            <p className="repository-default-note">修改默认分支只影响新建会话；已有会话仍使用创建时锁定的分支和代码版本。</p>
          </section>

          <form onSubmit={(event) => void submit(event)}>
            <div className="repository-section-title">
              <Plus size={16} />
              <strong>登记只读仓库</strong>
            </div>

            <div className="model-form-grid">
              <label className="form-field">
                <span>仓库名称</span>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：xesapp"
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  minLength={2}
                  required
                />
              </label>
              <label className="form-field">
                <span>默认分支 <small>可选</small></span>
                <div className="branch-input">
                  <GitBranch size={16} />
                  <input
                    value={defaultBranch}
                    onChange={(event) => setDefaultBranch(event.target.value)}
                    placeholder="留空读取远端 HEAD"
                  />
                </div>
              </label>
            </div>

            <label className="form-field">
              <span>Git 地址</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://git.example.com/group/repository.git"
                inputMode="url"
                required
              />
            </label>

            <div className="credential-note">
              <ShieldCheck size={16} />
              <span>仓库凭据由后端 Git Credential Helper 或只读 Deploy Key 提供，前端不接收 Token。</span>
            </div>

            {error && (
              <div className="form-error" role="alert">
                <AlertTriangle size={16} />
                <span>{error}</span>
              </div>
            )}

            <footer className="dialog-actions">
              <button className="secondary-button" type="button" onClick={onClose} disabled={pending || savingBranch}>
                关闭
              </button>
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                {pending ? '正在连接' : '登记仓库'}
              </button>
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}
