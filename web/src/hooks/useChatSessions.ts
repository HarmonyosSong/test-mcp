import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChatMessage } from '../agui/client';
import type { AguiEvent } from '../agui/events';
import { api } from '../api';
import { hasPendingFollowup } from '../lib/followup';
import { loadSessionState } from '../sessionFlow';
import type {
  ChatConversation,
  ChatConversationSummary,
  ConnectionState,
  CreateConversationInput,
} from '../types';

/** 单 loop 时代的进度提示：只有「进行中」一种状态，编排阶段的 waiting 已退役。 */
export interface ChatProgress {
  text: string;
}

/** 协查中轮询：5s 一次；上限略大于服务端协查等待上限（660s），超时收敛提示避免永久悬置。 */
const FOLLOWUP_POLL_INTERVAL_MS = 5_000;
const FOLLOWUP_POLL_MAX_MS = 12 * 60_000;

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
  progress: ChatProgress | null;
  /** 本轮已初步收尾、服务端协查仍在后台等待：提示用户结果稍后自动同步。 */
  followupPending: boolean;
  select: (id: string) => void;
  createNew: (input?: CreateConversationInput) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  send: (content: string) => Promise<void>;
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
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  const [followupPending, setFollowupPending] = useState(false);
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
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') setProgress(null);
      if (event.type === 'FOLLOWUP_PENDING') setFollowupPending(true);
      // 后台协查落地的补推快照：协查中状态收尾，顺手刷新列表预览。
      if (event.type === 'STATE_SNAPSHOT' && event.followup_message_id) {
        setFollowupPending(false);
        void refreshSummaries();
      }
    },
    [refreshSummaries],
  );

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const state = await loadSessionState(api, activeIdRef.current);
      setSummaries(state.summaries);
      setActive(state.active);
      activeIdRef.current = state.activeId;
      setActiveId(state.activeId);
      setProgress(null);
      // 刷新后恢复：按 consultations 推导是否有在途协查，有则亮起提示并进入轮询。
      setFollowupPending(state.active ? hasPendingFollowup(state.active) : false);
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

  // 协查中轮询：覆盖 SSE 已断的场景（刷新页面/重进会话/主动停止）。
  // 发送流进行中的 tick 跳过——流式中间态由 SSE 驱动，轮询快照回盖会让正文回跳。
  useEffect(() => {
    if (!followupPending || !activeId) return;
    const id = activeId;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (busyRef.current) return;
      if (Date.now() - startedAt > FOLLOWUP_POLL_MAX_MS) {
        setFollowupPending(false);
        return;
      }
      void api
        .getConversation(id)
        .then((detail) => {
          if (activeIdRef.current !== id || busyRef.current) return;
          if (hasPendingFollowup(detail)) return;
          // 协查已落地（consultation 脱离 sent）：整体刷新并收敛提示。
          setActive(detail);
          setFollowupPending(false);
          void refreshSummaries();
        })
        .catch(() => {
          // 网络抖动不致命，下个周期再试。
        });
    }, FOLLOWUP_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [followupPending, activeId, refreshSummaries]);

  const select = useCallback(
    (id: string) => {
      activeIdRef.current = id;
      setActiveId(id);
      setProgress(null);
      setFollowupPending(false);
      void api
        .getConversation(id)
        .then((conversation) => {
          if (activeIdRef.current === id) {
            setActive(conversation);
            setFollowupPending(hasPendingFollowup(conversation));
          }
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
      setFollowupPending(false);
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
          setFollowupPending(false);
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
      setProgress({ text: '正在检查应用' });
      setFollowupPending(false);
      try {
        await streamChatMessage(conversationId, content, {
          signal: abortController.signal,
          onEvent: (event, conversation) =>
            updateFromEvent(conversationId, event, conversation),
          // 流彻底结束（协查落地/超时未回/主动停止）：向服务端求证一次真实在途状态——
          // 仍在途则保持提示并转入轮询兜底，不落「提示消失但协查还活着」的中间态。
          onClose: () => {
            if (activeIdRef.current !== conversationId) return;
            void api
              .getConversation(conversationId)
              .then((detail) => {
                if (activeIdRef.current === conversationId) {
                  setFollowupPending(hasPendingFollowup(detail));
                }
              })
              .catch(() => setFollowupPending(false));
          },
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
        // 同步一次服务端真实状态（中断的回复会以 failed + 部分正文落盘）；
        // 主动停止不影响服务端协查收尾——若在途则恢复提示并转入轮询。
        try {
          const detail = await api.getConversation(conversationId);
          if (activeIdRef.current === conversationId) {
            setActive(detail);
            setFollowupPending(hasPendingFollowup(detail));
          }
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
    followupPending,
    select,
    createNew,
    refresh: load,
    remove,
    send,
    stop,
    setModelOverride,
  };
}
