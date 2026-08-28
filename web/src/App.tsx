import {
  Activity,
  AlertTriangle,
  FileSearch,
  ListChecks,
  MessageSquare,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AguiUnavailableError, streamDiagnosis } from './agui/client';
import { api } from './api';
import { ChatPanel } from './components/chat/ChatPanel';
import { Typewriter } from './components/Typewriter';
import { ChatThread } from './components/chat/ChatThread';
import { DiagnosisPanel } from './components/DiagnosisPanel';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';
import { NewCaseDialog } from './components/NewCaseDialog';
import { ProcessPanel } from './components/ProcessPanel';
import { QueuePanel } from './components/QueuePanel';
import { RepositorySettingsDialog } from './components/RepositorySettingsDialog';
import { Sidebar, type SidebarNav } from './components/Sidebar';
import { demoCases, demoMeta } from './demo';
import { useChatSessions } from './hooks/useChatSessions';
import type {
  ConnectionState,
  CreateCaseInput,
  DetailView,
  DiagnosticCase,
  MetaResponse,
  MobileView,
  ModelProviderPreset,
  ModelStatus,
  RepositoryRecord,
} from './types';

const POLL_INTERVAL_MS = 2_500;
const DEMO_MODEL_STATUS: ModelStatus = {
  mode: 'demo',
  configured: false,
  api_key_configured: false,
  compatibility_mode: 'standard',
};

interface Notice {
  kind: 'info' | 'error';
  message: string;
}

function mergeCase(list: DiagnosticCase[], detail: DiagnosticCase): DiagnosticCase[] {
  const exists = list.some((item) => item.id === detail.id);
  if (!exists) return [detail, ...list];
  return list.map((item) => (item.id === detail.id ? detail : item));
}

function App() {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [meta, setMeta] = useState<MetaResponse>(demoMeta);
  const [cases, setCases] = useState<DiagnosticCase[]>(demoCases);
  const [selectedId, setSelectedId] = useState<string | null>(demoCases[0]?.id || null);
  const [detailView, setDetailView] = useState<DetailView>('process');
  const [mobileView, setMobileView] = useState<MobileView>('process');
  const [sidebarNav, setSidebarNav] = useState<SidebarNav>('chat');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showRepositorySettings, setShowRepositorySettings] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderPreset[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus>(DEMO_MODEL_STATUS);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');
  const [caseDraftInitial, setCaseDraftInitial] = useState<CreateCaseInput | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const initialized = useRef(false);
  const streamingCaseIds = useRef(new Set<string>());
  const linkAfterCreate = useRef(false);

  const handleRepositoryRegistered = useCallback((repository: RepositoryRecord) => {
    setRepositories((current) =>
      [...current, repository].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setNotice({ kind: 'info', message: `${repository.name} 已登记，可按分支创建诊断。` });
  }, []);

  const chat = useChatSessions({
    connection,
    onNotice: setNotice,
    onRepositoryRegistered: handleRepositoryRegistered,
  });

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === selectedId) || null,
    [cases, selectedId],
  );
  const activeCount = cases.filter(
    (item) => item.status === 'queued' || item.status === 'running',
  ).length;
  const hasActiveCases = activeCount > 0;

  const loadWorkspace = useCallback(async (manual = false) => {
    setRefreshing(true);
    if (!manual) setConnection('checking');
    try {
      await api.health();
      const [nextMeta, nextCases, nextProviders, nextModelStatus, nextRepositories] = await Promise.all([
        api.meta(),
        api.listCases(),
        api.modelProviders(),
        api.modelStatus(),
        api.repositories(),
      ]);
      setMeta(nextMeta);
      setCases(nextCases);
      setModelProviders(nextProviders);
      setModelStatus(nextModelStatus);
      setRepositories(nextRepositories);
      setSelectedId((current) => {
        if (current && nextCases.some((item) => item.id === current)) return current;
        return nextCases[0]?.id || null;
      });
      setConnection('connected');
      if (manual) setNotice({ kind: 'info', message: '诊断服务数据已刷新。' });
    } catch {
      setConnection('demo');
      setMeta(demoMeta);
      setModelProviders([]);
      setModelStatus(DEMO_MODEL_STATUS);
      setRepositories([]);
      setCases(demoCases);
      setSelectedId((current) =>
        current && demoCases.some((item) => item.id === current)
          ? current
          : demoCases[0]?.id || null,
      );
      if (manual) {
        setNotice({ kind: 'error', message: '诊断服务仍未连接，继续展示演示案例。' });
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

  useEffect(() => {
    if (connection !== 'connected' || !hasActiveCases) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const nextCases = await api.listCases();
        let nextList = nextCases;
        const activeSelected = nextCases.find(
          (item) =>
            item.id === selectedId && (item.status === 'queued' || item.status === 'running'),
        );
        if (activeSelected) {
          const detail = await api.getCase(activeSelected.id);
          nextList = mergeCase(nextCases, detail);
        }
        if (!cancelled) {
          setCases((current) => {
            const streamingCases = current.filter((item) =>
              streamingCaseIds.current.has(item.id),
            );
            return streamingCases.reduce(mergeCase, nextList);
          });
        }
      } catch {
        // Keep the last known state; a later poll or manual refresh can recover.
      }
    };

    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connection, hasActiveCases, selectedId]);

  const handleSelect = useCallback(
    (diagnosticCase: DiagnosticCase) => {
      setSelectedId(diagnosticCase.id);
      setMobileView('process');
      setDetailView('process');
      setSidebarNav('tasks');

      if (connection === 'connected') {
        void api
          .getCase(diagnosticCase.id)
          .then((detail) => setCases((current) => mergeCase(current, detail)))
          .catch(() => {
            setNotice({ kind: 'error', message: '案例详情刷新失败，已保留上次结果。' });
          });
      }
    },
    [connection],
  );

  const handleNavChange = useCallback((nav: SidebarNav) => {
    setSidebarNav(nav);
    if (nav === 'chat') setMobileView('process');
  }, []);

  const openCreateDialog = useCallback(() => {
    setCreateError('');
    setCaseDraftInitial(null);
    linkAfterCreate.current = false;
    setShowCreateDialog(true);
  }, []);

  const handlePromoteDraft = useCallback(async () => {
    const draft = await chat.requestDraft();
    if (!draft) return;
    setCreateError('');
    setCaseDraftInitial(draft);
    linkAfterCreate.current = true;
    setShowCreateDialog(true);
  }, [chat]);

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

  const handleOpenCaseFromChat = useCallback(
    (caseId: string) => {
      setSidebarNav('tasks');
      setDetailView('process');
      setMobileView('process');
      if (cases.some((item) => item.id === caseId)) {
        setSelectedId(caseId);
      } else if (connection === 'connected') {
        void api
          .getCase(caseId)
          .then((detail) => {
            setCases((current) => mergeCase(current, detail));
            setSelectedId(caseId);
          })
          .catch(() => {
            setNotice({ kind: 'error', message: '案例详情加载失败。' });
          });
      }
    },
    [cases, connection],
  );

  const handleModelChanged = useCallback((nextStatus: ModelStatus, message: string) => {
    setModelStatus(nextStatus);
    setShowModelSettings(false);
    setNotice({ kind: 'info', message });
    void loadWorkspace();
  }, [loadWorkspace]);

  const closeCreateDialog = useCallback(() => {
    if (submitting) return;
    setShowCreateDialog(false);
    setCaseDraftInitial(null);
    linkAfterCreate.current = false;
  }, [submitting]);

  const handleCreate = async (input: CreateCaseInput) => {
    if (connection !== 'connected') {
      setCreateError('服务未连接，演示模式不能创建或执行诊断案例。');
      return;
    }

    setSubmitting(true);
    setCreateError('');
    let usedRestFallback = false;
    let streamStarted = false;
    try {
      let created: DiagnosticCase;
      try {
        created = await streamDiagnosis(input, {
          onEvent: (_event, streamedCase) => {
            if (!streamedCase) return;
            streamStarted = true;
            streamingCaseIds.current.add(streamedCase.id);
            setCases((current) => mergeCase(current, streamedCase));
            setSelectedId(streamedCase.id);
            setShowCreateDialog(false);
          },
        });
      } catch (error) {
        if (!(error instanceof AguiUnavailableError)) throw error;
        usedRestFallback = true;
        created = await api.createCase(input);
      }
      setCases((current) => mergeCase(current, created));
      setSelectedId(created.id);
      setDetailView('process');
      setMobileView('process');
      setSidebarNav('tasks');
      setShowCreateDialog(false);
      setCaseDraftInitial(null);
      if (linkAfterCreate.current) {
        linkAfterCreate.current = false;
        void chat.linkCase(created.id);
      }
      if (created.status === 'completed') {
        setNotice({ kind: 'info', message: '诊断已完成。' });
      } else if (usedRestFallback) {
        setNotice({
          kind: 'info',
          message: 'AG-UI 流暂不可用，已切换到兼容队列模式。',
        });
      } else if (created.status !== 'failed') {
        setNotice({ kind: 'info', message: '案例已进入诊断队列。' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '案例提交失败，请稍后重试。';
      setCreateError(message);
      if (streamStarted) setNotice({ kind: 'error', message });
    } finally {
      streamingCaseIds.current.clear();
      setSubmitting(false);
    }
  };

  const selectDetailView = (view: DetailView) => {
    setDetailView(view);
    setMobileView(view);
    setSidebarNav('tasks');
  };

  return (
    <div className="app-shell">
      <div className="body-row" data-mobile-view={mobileView}>
        <Sidebar
          connection={connection}
          activeNav={sidebarNav}
          caseCount={cases.length}
          refreshing={refreshing}
          onNavChange={handleNavChange}
          onRefresh={() => void loadWorkspace(true)}
          onModelSettings={openModelSettings}
          onRepositorySettings={openRepositorySettings}
        >
          {sidebarNav === 'chat' ? (
            <ChatPanel
              summaries={chat.summaries}
              activeId={chat.activeId}
              onSelect={chat.select}
              onCreate={() => void chat.createNew()}
              onDelete={(id) => void chat.remove(id)}
            />
          ) : (
            <QueuePanel
              cases={cases}
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewCase={openCreateDialog}
            />
          )}
        </Sidebar>

        <main className="main-area">
          {connection === 'demo' && (
            <div className="demo-banner" role="status">
              <AlertTriangle size={15} />
              <span>
                <strong>API 未连接</strong> · 当前显示内置演示案例，提交操作不会写入服务。
              </span>
            </div>
          )}

          <nav className="mobile-view-nav" aria-label="工作台视图">
            <button
              type="button"
              className={mobileView === 'cases' ? 'selected' : ''}
              onClick={() => setMobileView('cases')}
            >
              <ListChecks size={17} />
              案例
              <span>{cases.length}</span>
            </button>
            <button
              type="button"
              className={mobileView === 'process' ? 'selected' : ''}
              onClick={() => selectDetailView('process')}
            >
              <Activity size={17} />
              过程
            </button>
            <button
              type="button"
              className={mobileView === 'diagnosis' ? 'selected' : ''}
              onClick={() => selectDetailView('diagnosis')}
            >
              <FileSearch size={17} />
              诊断
            </button>
          </nav>

          {sidebarNav === 'chat' ? (
            connection !== 'connected' ? (
              <div className="chat-guide" role="status">
                <span className="chat-guide-icon" aria-hidden="true">
                  <MessageSquare size={30} strokeWidth={1.6} />
                </span>
                <h2><Typewriter text="聊天需要连接诊断服务" /></h2>
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
                <h2><Typewriter text="聊天需要先配置模型" /></h2>
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
                promotePending={chat.promotePending}
                modelStatus={modelStatus}
                contextWindows={meta.context_windows || {}}
                modelPrices={meta.model_prices || {}}
                onSend={(content) => void chat.send(content)}
                onStop={chat.stop}
                onPromote={() => void handlePromoteDraft()}
                onOpenCase={handleOpenCaseFromChat}
                onModelChange={(spec) => void chat.setModelOverride(spec)}
              />
            ) : (
              <div className="chat-guide" role="status">
                <span className="chat-guide-icon" aria-hidden="true">
                  <MessageSquare size={30} strokeWidth={1.6} />
                </span>
                <h2><Typewriter text="开始一个新的会话" /></h2>
                <p>每个会话独立保存消息历史和工具调用记录。</p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void chat.createNew()}
                >
                  新建会话
                </button>
              </div>
            )
          ) : (
            <section className="case-area" data-detail-view={detailView}>
              <div className="detail-view-switch" role="tablist" aria-label="案例详情视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailView === 'process'}
                  className={detailView === 'process' ? 'selected' : ''}
                  onClick={() => selectDetailView('process')}
                >
                  <Activity size={16} />
                  诊断过程
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailView === 'diagnosis'}
                  className={detailView === 'diagnosis' ? 'selected' : ''}
                  onClick={() => selectDetailView('diagnosis')}
                >
                  <FileSearch size={16} />
                  证据与诊断
                </button>
              </div>
              <ProcessPanel diagnosticCase={selectedCase} />
              <DiagnosisPanel diagnosticCase={selectedCase} meta={meta} />
            </section>
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

      {showCreateDialog && (
        <NewCaseDialog
          connection={connection}
          submitting={submitting}
          error={createError}
          repositories={repositories}
          initialValue={caseDraftInitial}
          onClose={closeCreateDialog}
          onSubmit={(input) => void handleCreate(input)}
        />
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
