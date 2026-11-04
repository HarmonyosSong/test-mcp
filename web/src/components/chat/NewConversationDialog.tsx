import { AlertTriangle, GitBranch, GitFork, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { RepositoryBranch, RepositoryRecord } from '../../types';
import { conversationCreateInput, loadRepositoryBranches } from '../../sessionFlow';

interface NewConversationDialogProps {
  repositories: RepositoryRecord[];
  onClose: () => void;
  onCreate: (input: ReturnType<typeof conversationCreateInput>) => Promise<boolean>;
}

export function NewConversationDialog({ repositories, onClose, onCreate }: NewConversationDialogProps) {
  const [repositoryId, setRepositoryId] = useState('');
  const [branches, setBranches] = useState<RepositoryBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    if (!repositoryId) {
      setBranches([]);
      setBranch('');
      setError('');
      return;
    }
    if (!repositories.some((item) => item.id === repositoryId)) return;

    const currentRequest = ++requestId.current;
    setLoadingBranches(true);
    setBranches([]);
    setBranch('');
    setError('');
    void loadRepositoryBranches(repositoryId, repositories, api.repositoryBranches).then((result) => {
      if (requestId.current !== currentRequest) return;
      setBranches(result.branches);
      setBranch(result.selectedBranch);
    }).catch((nextError) => {
      if (requestId.current === currentRequest) {
        setError(nextError instanceof Error ? nextError.message : '分支列表加载失败。');
      }
    }).finally(() => {
      if (requestId.current === currentRequest) setLoadingBranches(false);
    });
    return () => {
      requestId.current += 1;
    };
  }, [repositoryId, repositories]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      if (await onCreate(conversationCreateInput(repositoryId, branch))) onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '创建会话失败。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section className="new-case-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">NEW CONVERSATION</span>
            <h2 id="new-conversation-title">新建会话</h2>
          </div>
          <button className="icon-button light" type="button" onClick={onClose} disabled={pending} title="关闭" aria-label="关闭新建会话">
            <X size={19} />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <label className="form-field">
            <span>代码仓库 <small>可选</small></span>
            <div className="branch-input">
              <GitFork size={16} />
              <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} disabled={pending}>
                <option value="">普通会话，不绑定仓库</option>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>{repository.name}</option>
                ))}
              </select>
            </div>
          </label>

          {repositoryId && (
            <label className="form-field">
              <span>诊断分支</span>
              <div className="branch-input">
                <GitBranch size={16} />
                <select
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  disabled={pending || loadingBranches || branches.length === 0}
                  required
                >
                  {loadingBranches ? <option value="">正在加载分支…</option> : null}
                  {!loadingBranches && branches.length === 0 ? <option value="">没有可用分支</option> : null}
                  {branches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
                {loadingBranches && <LoaderCircle className="spin" size={15} />}
              </div>
            </label>
          )}

          {repositoryId && branches.length === 0 && !loadingBranches && !error && (
            <p className="field-error-text">仓库没有可用分支，请检查仓库连接后重试。</p>
          )}
          {error && <div className="form-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

          <footer className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="primary-button" type="submit" disabled={pending || loadingBranches || Boolean(repositoryId && !branch)}>
              {pending ? <LoaderCircle className="spin" size={16} /> : <MessageSquare size={16} />}
              {pending ? '正在创建' : '创建会话'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
