import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  GitFork,
  LoaderCircle,
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
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pending]);

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

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
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
            disabled={pending}
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
                    <code>{repository.default_branch}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div className="repository-empty">尚未登记业务仓库</div>
            )}
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
              <button className="secondary-button" type="button" onClick={onClose} disabled={pending}>
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
