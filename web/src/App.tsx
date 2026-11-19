import { Activity, AlertTriangle, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { logout, useServerSession } from './auth';
import { ChatPanel } from './components/chat/ChatPanel';
import { NewConversationDialog } from './components/chat/NewConversationDialog';
import { ChatThread } from './components/chat/ChatThread';
import { HudBar } from './components/HudBar';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Typewriter } from './components/Typewriter';
import { useChatSessions } from './hooks/useChatSessions';
import type {
  ConnectionState,
  MetaResponse,
  ModelProviderPreset,
  ModelStatus,
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
  const session = useServerSession();
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [meta, setMeta] = useState<MetaResponse>(EMPTY_META);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [modelProviders, setModelProviders] = useState<ModelProviderPreset[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>(OFFLINE_MODEL_STATUS);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const initialized = useRef(false);

  const chat = useChatSessions({
    connection,
    onNotice: setNotice,
  });

  const loadWorkspace = useCallback(async (manual = false, manageRefreshing = true): Promise<boolean> => {
    if (manageRefreshing) setRefreshing(true);
    if (!manual) setConnection('checking');
    try {
      await api.health();
      const [nextMeta, nextProviders, nextModelStatus] = await Promise.all([
        api.meta(),
        api.modelProviders(),
        api.modelStatus(),
      ]);
      setMeta(nextMeta);
      setModelProviders(nextProviders);
      setModelStatus(nextModelStatus);
      setConnection('connected');
      if (manual) setNotice({ kind: 'info', message: '诊断服务数据已刷新。' });
      return true;
    } catch {
      setConnection('demo');
      setMeta(EMPTY_META);
      setModelProviders([]);
      setModelStatus(OFFLINE_MODEL_STATUS);
      if (manual) {
        setNotice({ kind: 'error', message: '诊断服务仍未连接，请稍后重试。' });
      }
      return false;
    } finally {
      if (manageRefreshing) setRefreshing(false);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!(await loadWorkspace(true, false))) return;
      if (!(await chat.refresh())) {
        setNotice({ kind: 'error', message: '会话刷新失败，请稍后重试。' });
        return;
      }
      setNotice({ kind: 'info', message: '会话和诊断服务数据已刷新。' });
    } finally {
      setRefreshing(false);
    }
  }, [chat.refresh, loadWorkspace]);

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

  const handleModelChanged = useCallback(
    (nextStatus: ModelStatus, message: string) => {
      setModelStatus(nextStatus);
      setShowModelSettings(false);
      setNotice({ kind: 'info', message });
      void loadWorkspace();
    },
    [loadWorkspace],
  );

  const handleLogout = useCallback(() => {
    void logout()
      .then((logoutUrl) => {
        window.location.assign(logoutUrl);
      })
      .catch(() => {
        setNotice({ kind: 'error', message: '退出登录失败，请稍后重试。' });
      });
  }, []);

  return (
    <div className="app-shell">
      <div className="body-row">
        <Sidebar
          connection={connection}
          refreshing={refreshing}
          identityLabel={session?.identity.displayName || session?.identity.subject}
          onRefresh={() => void refreshWorkspace()}
          onModelSettings={openModelSettings}
          onLogout={session?.authMode === 'sso' ? handleLogout : undefined}
        >
          <ChatPanel
            summaries={chat.summaries}
            activeId={chat.activeId}
            onSelect={chat.select}
            onCreate={() => setShowNewConversation(true)}
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
              <p>连接服务并配置模型后，即可通过多轮对话排查 Android、iOS 和 HarmonyOS 问题。</p>
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
              progress={chat.progress}
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

      {showNewConversation && (
        <NewConversationDialog
          onClose={() => setShowNewConversation(false)}
          onCreate={chat.createNew}
        />
      )}

      <HudBar connection={connection} modelStatus={modelStatus} />
    </div>
  );
}

export default App;
