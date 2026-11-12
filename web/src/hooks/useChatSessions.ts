import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChatMessage, streamConsultationDecision } from '../agui/client';
import type { AguiEvent } from '../agui/events';
import {
  investigationProgressForEvent,
  type InvestigationProgress,
} from '../agui/progress';
import { api } from '../api';
import { consultationDecisionErrorMessage } from '../consultation';
import { loadSessionState } from '../sessionFlow';
import type {
  ChatConversation,
  ChatConversationSummary,
  ConnectionState,
  ConsultationAction,
  CreateConversationInput,
} from '../types';

interface UseChatSessionsOptions {
  connection: ConnectionState;
  onNotice: (notice: { kind: 'info' | 'error'; message: string }) => void;
}

export interface ChatController {
  summaries: ChatConversationSummary[];
  active: ChatConversation | null;
  activeId: string | null;
  sending: boolean;
  loaded: boolean;
  progress: InvestigationProgress | null;
  consultationAction: ConsultationAction | null;
  select: (id: string) => void;
  createNew: (input?: CreateConversationInput) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  send: (content: string) => Promise<void>;
  decideConsultation: (
    consultationId: string,
    decision: ConsultationAction['decision'],
  ) => Promise<void>;
  stop: () => void;
  setModelOverride: (spec: string) => Promise<void>;
}

export function useChatSessions({
  connection,
  onNotice,
}: UseChatSessionsOptions): ChatController {
  const [summaries, setSummaries] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<InvestigationProgress | null>(null);
  const [consultationAction, setConsultationAction] = useState<ConsultationAction | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const abortRef = useRef<AbortController | null>(null);
  // 状态提交到下一次渲染之间仍可能连点，同步锁负责真正的请求防重。
  const busyRef = useRef(false);

  const refreshSummaries = useCallback(async () => {
    const list = await api.listConversations();
    setSummaries(list);
  }, []);

  const updateFromEvent = useCallback(
    (conversationId: string, event: AguiEvent, conversation: ChatConversation | null) => {
      if (activeIdRef.current !== conversationId) return;
      if (conversation && conversation.id === conversationId) setActive(conversation);
      const nextProgress = investigationProgressForEvent(event);
      if (nextProgress) setProgress(nextProgress);
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') setProgress(null);
    },
    [],
  );

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const state = await loadSessionState(api, activeIdRef.current);
      setSummaries(state.summaries);
      setActive(state.active);
      activeIdRef.current = state.activeId;
      setActiveId(state.activeId);
      setProgress(null);
      setLoaded(true);
      return true;
    } catch {
      onNotice({ kind: 'error', message: '会话列表加载失败，请稍后刷新。' });
      return false;
    }
  }, [onNotice]);

  useEffect(() => {
    if (connection === 'connected' && !loaded) void load();
  }, [connection, loaded, load]);

  const select = useCallback(
    (id: string) => {
      activeIdRef.current = id;
      setActiveId(id);
      setProgress(null);
      void api
        .getConversation(id)
        .then((conversation) => {
          if (activeIdRef.current === id) setActive(conversation);
        })
        .catch(() => onNotice({ kind: 'error', message: '会话详情加载失败。' }));
    },
    [onNotice],
  );

  const createNew = useCallback(async (input: CreateConversationInput = {}) => {
    try {
      const created = await api.createConversation(input);
      await refreshSummaries();
      activeIdRef.current = created.id;
      setActive(created);
      setActiveId(created.id);
      setProgress(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建会话失败';
      onNotice({ kind: 'error', message });
      return false;
    }
  }, [onNotice, refreshSummaries]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        await refreshSummaries();
        if (activeIdRef.current === id) {
          activeIdRef.current = null;
          setActiveId(null);
          setActive(null);
          setProgress(null);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除会话失败';
        onNotice({ kind: 'error', message });
      }
    },
    [onNotice, refreshSummaries],
  );

  const send = useCallback(
    async (content: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || busyRef.current) return;

      busyRef.current = true;
      const abortController = new AbortController();
      abortRef.current = abortController;
      setSending(true);
      setProgress({ text: '正在检查应用', state: 'active' });
      try {
        await streamChatMessage(conversationId, content, {
          signal: abortController.signal,
          onEvent: (event, conversation) =>
            updateFromEvent(conversationId, event, conversation),
        });
        void refreshSummaries();
      } catch (error) {
        const aborted =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted) {
          const message = error instanceof Error ? error.message : '消息发送失败';
          onNotice({ kind: 'error', message });
        }
        // 同步一次服务端真实状态（中断的回复会以 failed + 部分正文落盘）
        try {
          const detail = await api.getConversation(conversationId);
          if (activeIdRef.current === conversationId) setActive(detail);
        } catch {
          // 保留本地状态
        }
        void refreshSummaries();
      } finally {
        if (abortRef.current === abortController) abortRef.current = null;
        busyRef.current = false;
        setSending(false);
      }
    },
    [onNotice, refreshSummaries, updateFromEvent],
  );

  const decideConsultation = useCallback(
    async (consultationId: string, decision: ConsultationAction['decision']) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || busyRef.current) return;

      busyRef.current = true;
      const abortController = new AbortController();
      abortRef.current = abortController;
      setConsultationAction({ consultationId, decision });
      setSending(true);
      setProgress({
        text: decision === 'approve' ? '正在继续排查' : '正在整理结论',
        state: 'active',
      });
      try {
        await streamConsultationDecision(conversationId, consultationId, decision, {
          signal: abortController.signal,
          onEvent: (event, conversation) =>
            updateFromEvent(conversationId, event, conversation),
        });
        void refreshSummaries();
      } catch (error) {
        const aborted =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted) {
          onNotice({
            kind: 'error',
            message: consultationDecisionErrorMessage(error, decision),
          });
        }
        // 409、429、中断和流错误都重新读取真实状态，绝不靠本地猜测审批结果。
        try {
          const detail = await api.getConversation(conversationId);
          if (activeIdRef.current === conversationId) setActive(detail);
        } catch {
          // 保留确认卡片，便于用户稍后重试或手动刷新。
        }
        void refreshSummaries();
      } finally {
        if (abortRef.current === abortController) abortRef.current = null;
        busyRef.current = false;
        setConsultationAction(null);
        setSending(false);
      }
    },
    [onNotice, refreshSummaries, updateFromEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const setModelOverride = useCallback(
    async (spec: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      try {
        const updated = await api.updateConversation(conversationId, {
          model_override: spec,
        });
        if (activeIdRef.current === conversationId) setActive(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : '切换模型失败';
        onNotice({ kind: 'error', message });
      }
    },
    [onNotice],
  );

  return {
    summaries,
    active,
    activeId,
    sending,
    loaded,
    progress,
    consultationAction,
    select,
    createNew,
    refresh: load,
    remove,
    send,
    decideConsultation,
    stop,
    setModelOverride,
  };
}
