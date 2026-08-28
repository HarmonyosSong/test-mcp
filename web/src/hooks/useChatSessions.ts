import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChatMessage } from '../agui/client';
import { api } from '../api';
import {
  detectRepositoryBindingIntent,
  registerRepositoryByName,
} from '../lib/repositoryBinding';
import type {
  CaseDraft,
  ChatConversation,
  ChatConversationSummary,
  ConnectionState,
  RepositoryRecord,
} from '../types';

interface UseChatSessionsOptions {
  connection: ConnectionState;
  onNotice: (notice: { kind: 'info' | 'error'; message: string }) => void;
  onRepositoryRegistered?: (repository: RepositoryRecord) => void;
}

export interface ChatController {
  summaries: ChatConversationSummary[];
  active: ChatConversation | null;
  activeId: string | null;
  sending: boolean;
  promotePending: boolean;
  loaded: boolean;
  select: (id: string) => void;
  createNew: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  send: (content: string) => Promise<void>;
  stop: () => void;
  requestDraft: () => Promise<CaseDraft | null>;
  linkCase: (caseId: string) => Promise<void>;
  setModelOverride: (spec: string) => Promise<void>;
}

export function useChatSessions({
  connection,
  onNotice,
  onRepositoryRegistered,
}: UseChatSessionsOptions): ChatController {
  const [summaries, setSummaries] = useState<ChatConversationSummary[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [promotePending, setPromotePending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const abortRef = useRef<AbortController | null>(null);

  const refreshSummaries = useCallback(async () => {
    const list = await api.listConversations();
    setSummaries(list);
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await api.listConversations();
      setSummaries(list);
      setLoaded(true);
      const currentId = activeIdRef.current;
      if (currentId && list.some((item) => item.id === currentId)) {
        const detail = await api.getConversation(currentId);
        setActive(detail);
        return;
      }
      if (list.length > 0) {
        const detail = await api.getConversation(list[0].id);
        setActive(detail);
        setActiveId(list[0].id);
      } else {
        setActive(null);
        setActiveId(null);
      }
    } catch {
      onNotice({ kind: 'error', message: '会话列表加载失败，请稍后刷新。' });
    }
  }, [onNotice]);

  useEffect(() => {
    if (connection === 'connected' && !loaded) void load();
  }, [connection, loaded, load]);

  const select = useCallback(
    (id: string) => {
      setActiveId(id);
      void api
        .getConversation(id)
        .then(setActive)
        .catch(() => onNotice({ kind: 'error', message: '会话详情加载失败。' }));
    },
    [onNotice],
  );

  const createNew = useCallback(async () => {
    try {
      const created = await api.createConversation({});
      await refreshSummaries();
      setActive(created);
      setActiveId(created.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建会话失败';
      onNotice({ kind: 'error', message });
    }
  }, [onNotice, refreshSummaries]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        await refreshSummaries();
        if (activeIdRef.current === id) {
          setActiveId(null);
          setActive(null);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除会话失败';
        onNotice({ kind: 'error', message });
      }
    },
    [onNotice, refreshSummaries],
  );

  const appendLocalMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      setActive((current) => {
        if (!current) return current;
        const now = new Date().toISOString();
        const message = {
          id: `local-${now}-${Math.random().toString(36).slice(2, 8)}`,
          role,
          content,
          steps: [],
          status: 'completed' as const,
          created_at: now,
        };
        return {
          ...current,
          messages: [...current.messages, message],
          updated_at: now,
        };
      });
    },
    [],
  );

  const send = useCallback(
    async (content: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || sending) return;

      // 先检测是否为“绑定仓库”类自然语言指令
      const bindingTarget = detectRepositoryBindingIntent(content);
      if (bindingTarget) {
        setSending(true);
        try {
          const repository = await registerRepositoryByName(bindingTarget);
          appendLocalMessage('user', content);
          appendLocalMessage(
            'assistant',
            `已绑定仓库 ${repository.name}\nURL：${repository.url}\n默认分支：${repository.default_branch}`,
          );
          onRepositoryRegistered?.(repository);
          onNotice({ kind: 'info', message: `${repository.name} 已登记。` });
          void refreshSummaries();
        } catch (error) {
          const message = error instanceof Error ? error.message : '仓库绑定失败';
          appendLocalMessage('user', content);
          appendLocalMessage('assistant', `绑定仓库失败：${message}`);
          onNotice({ kind: 'error', message });
        } finally {
          setSending(false);
        }
        return;
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      setSending(true);
      try {
        await streamChatMessage(conversationId, content, {
          signal: abortController.signal,
          onEvent: (_event, conversation) => {
            if (conversation && conversation.id === conversationId) {
              setActive(conversation);
            }
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
        // 同步一次服务端真实状态（中断的回复会以 failed + 部分正文落盘）
        try {
          const detail = await api.getConversation(conversationId);
          setActive(detail);
        } catch {
          // 保留本地状态
        }
        void refreshSummaries();
      } finally {
        abortRef.current = null;
        setSending(false);
      }
    },
    [appendLocalMessage, onNotice, onRepositoryRegistered, refreshSummaries, sending],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const requestDraft = useCallback(async (): Promise<CaseDraft | null> => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return null;
    setPromotePending(true);
    try {
      return await api.promoteDraft(conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '提取案例草稿失败';
      onNotice({ kind: 'error', message });
      return null;
    } finally {
      setPromotePending(false);
    }
  }, [onNotice]);

  const linkCase = useCallback(
    async (caseId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      try {
        const updated = await api.linkCase(conversationId, caseId);
        setActive(updated);
        void refreshSummaries();
      } catch (error) {
        const message = error instanceof Error ? error.message : '案例关联失败';
        onNotice({ kind: 'error', message });
      }
    },
    [onNotice, refreshSummaries],
  );

  const setModelOverride = useCallback(
    async (spec: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      try {
        const updated = await api.updateConversation(conversationId, {
          model_override: spec,
        });
        setActive(updated);
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
    promotePending,
    loaded,
    select,
    createNew,
    remove,
    send,
    stop,
    requestDraft,
    linkCase,
    setModelOverride,
  };
}
