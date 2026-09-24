import { Activity, AlertTriangle, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ChatPanel } from './components/chat/ChatPanel';
import { ChatThread } from './components/chat/ChatThread';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';
import { RepositorySettingsDialog } from './components/RepositorySettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Typewriter } from './components/Typewriter';
import { useChatSessions } from './hooks/useChatSessions';
import type {
  ConnectionState,
  MetaResponse,
  ModelProviderPreset,
  ModelStatus,
  RepositoryRecord,
} from './types';

const EMPTY_META: MetaResponse = {
  mode: 'demo',
  model: null,
  skills: [],
  mcp_tools: [],
  constraints: [],
  context_windows: {},
  model_prices: {},
};

const OFFLINE_MODEL_STATUS: ModelStatus = {
  mode: 'demo',
  configured: false,
  api_key_configured: false,
  compatibility_mode: 'standard',
};

interface Notice {
  kind: 'info' | 'error';
  message: string;
}

function App() {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [meta, setMeta] = useState<MetaResponse>(EMPTY_META);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showRepositorySettings, setShowRepositorySettings] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderPreset[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>(OFFLINE_MODEL_STATUS);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const initialized = useRef(false);

  const handleRepositoryRegistered = useCallback((repository: RepositoryRecord) => {
    setRepositories((current) =>
      [...current, repository].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);

  const chat = useChatSessions({
    connection,
    onNotice: setNotice,
  });

  const loadWorkspace = useCallback(async (manual = false) => {
    setRefreshing(true);
    if (!manual) setConnection('checking');
    try {
      await api.health();
      const [nextMeta, nextProviders, nextModelStatus, nextRepositories] = await Promise.all([
        api.meta(),
        api.modelProviders(),
        api.modelStatus(),
        api.repositories(),
      ]);
      setMeta(nextMeta);
      setModelProviders(nextProviders);
      setModelStatus(nextModelStatus);
      setRepositories(nextRepositories);
      setConnection('connected');
      if (manual) setNotice({ kind: 'info', message: '诊断服务数据已刷新。' });
    } catch {
      setConnection('demo');
      setMeta(EMPTY_META);
      setModelProviders([]);
      setModelStatus(OFFLINE_MODEL_STATUS);
      setRepositories([]);
      if (manual) {
        setNotice({ kind: 'error', message: '诊断服务仍未连接，请稍后重试。' });
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const openModelSettings = useCallback(() => {
    if (connection !== 'connected') {
      setNotice({ kind: 'error', message: '连接诊断服务后才能配置模型。' });
      return;
    }
    setShowModelSettings(true);
  }, [connection]);

  const openRepositorySettings = useCallback(() => {
    if (connection !== 'connected') {
      setNotice({ kind: 'error', message: '连接诊断服务后才能管理业务仓库。' });
      return;
    }
    setShowRepositorySettings(true);
  }, [connection]);

  const handleModelChanged = useCallback(
    (nextStatus: ModelStatus, message: string) => {
      setModelStatus(nextStatus);
      setShowModelSettings(false);
      setNotice({ kind: 'info', message });
      void loadWorkspace();
    },
    [loadWorkspace],
  );

  return (
    <div className="app-shell">
      <div className="body-row">
        <Sidebar
          connection={connection}
          refreshing={refreshing}
          onRefresh={() => void loadWorkspace(true)}
          onModelSettings={openModelSettings}
          onRepositorySettings={openRepositorySettings}
        >
          <ChatPanel
            summaries={chat.summaries}
            activeId={chat.activeId}
            onSelect={chat.select}
            onCreate={() => void chat.createNew()}
            onDelete={(id) => void chat.remove(id)}
          />
        </Sidebar>

        <main className="main-area">
          {connection === 'demo' && (
            <div className="demo-banner" role="status">
              <AlertTriangle size={15} />
              <span>
                <strong>API 未连接</strong> · 聊天诊断不可用，请启动后端服务后重新连接。
              </span>
            </div>
          )}

          {connection !== 'connected' ? (
            <div className="chat-guide" role="status">
              <span className="chat-guide-icon" aria-hidden="true">
                <MessageSquare size={30} strokeWidth={1.6} />
              </span>
              <h2>
                <Typewriter text="聊天需要连接诊断服务" />
              </h2>
              <p>连接服务并配置模型后，即可通过多轮对话排查 HarmonyOS 问题。</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void loadWorkspace(true)}
              >
                重新连接
              </button>
            </div>
          ) : !modelStatus.configured ? (
            <div className="chat-guide" role="status">
              <span className="chat-guide-icon" aria-hidden="true">
                <MessageSquare size={30} strokeWidth={1.6} />
              </span>
              <h2>
                <Typewriter text="聊天需要先配置模型" />
              </h2>
              <p>对话能力由模型驱动，配置模型后即可开始提问。</p>
              <button type="button" className="primary-button" onClick={openModelSettings}>
                打开模型设置
              </button>
            </div>
          ) : chat.active ? (
            <ChatThread
              conversation={chat.active}
              sending={chat.sending}
              composerDisabled={false}
              modelStatus={modelStatus}
              contextWindows={meta.context_windows || {}}
              modelPrices={meta.model_prices || {}}
              onSend={(content) => void chat.send(content)}
              onStop={chat.stop}
              onModelChange={(spec) => void chat.setModelOverride(spec)}
            />
          ) : (
            <div className="chat-guide" role="status">
              <span className="chat-guide-icon" aria-hidden="true">
                <MessageSquare size={30} strokeWidth={1.6} />
              </span>
              <h2>
                <Typewriter text="开始一个新的会话" />
              </h2>
              <p>每个会话独立保存消息历史、工具调用记录与诊断报告。</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void chat.createNew()}
              >
                新建会话
              </button>
            </div>
          )}
        </main>
      </div>

      {notice && (
        <div className={`toast toast-${notice.kind}`} role="status">
          {notice.kind === 'error' ? <AlertTriangle size={17} /> : <Activity size={17} />}
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}

      {showModelSettings && modelProviders.length > 0 && (
        <ModelSettingsDialog
          providers={modelProviders}
          status={modelStatus}
          onClose={() => setShowModelSettings(false)}
          onChanged={handleModelChanged}
        />
      )}

      {showRepositorySettings && (
        <RepositorySettingsDialog
          repositories={repositories}
          onClose={() => setShowRepositorySettings(false)}
          onRegistered={handleRepositoryRegistered}
        />
      )}
    </div>
  );
}

export default App;
