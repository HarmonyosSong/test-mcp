import { Select } from '@arco-design/web-react';
import { AlertTriangle, ArrowRight, MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { formatDate } from '../../format';
import type { ChatConversation, ChatMessage, ModelStatus } from '../../types';
import { ChatComposer } from './ChatComposer';
import { ToolStepCard } from './ToolStepCard';

interface ChatThreadProps {
  conversation: ChatConversation;
  sending: boolean;
  composerDisabled: boolean;
  promotePending: boolean;
  modelStatus: ModelStatus;
  contextWindows: Record<string, number>;
  modelPrices: Record<string, { input: number; output: number }>;
  onSend: (content: string) => void;
  onStop: () => void;
  onPromote: () => void;
  onOpenCase: (caseId: string) => void;
  onModelChange: (spec: string) => void;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 本轮花费估算（元）：价格表按当前模型取，缓存折扣/套餐价不含在内。 */
function estimateCost(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  modelName: string,
  prices: Record<string, { input: number; output: number }>,
): number | null {
  const price = prices[modelName];
  if (!price || inputTokens == null) return null;
  return (inputTokens / 1_000_000) * price.input + ((outputTokens ?? 0) / 1_000_000) * price.output;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `¥${cost.toFixed(4)}`;
  if (cost < 1) return `¥${cost.toFixed(3)}`;
  return `¥${cost.toFixed(2)}`;
}

/** 从模型名解析上下文窗口的兜底：如 k3-256k → 256k，k3-1m → 1M。 */
function inferContextWindow(modelName: string): number | undefined {
  const match = modelName.toLowerCase().match(/(?:^|[^0-9])(\d+)\s*(k|m)(?:[^0-9]|$)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2] === 'm' ? value * 1_048_576 : value * 1_024;
}

function AssistantMessage({
  message,
  live,
  cost,
  onOpenCase,
}: {
  message: ChatMessage;
  /** 是否为本会话正在进行的回复；否则 streaming 视为中断的遗留消息 */
  live: boolean;
  /** 本轮花费估算文本；无价格数据时为 null */
  cost: string | null;
  onOpenCase: (caseId: string) => void;
}) {
  const interrupted = message.status === 'failed' || (message.status === 'streaming' && !live);
  return (
    <div className={`chat-message chat-message-assistant chat-message-${message.status}`}>
      {message.steps.length > 0 && (
        <div className="chat-steps" aria-label="工具调用步骤">
          {message.steps.map((step) => (
            <ToolStepCard key={step.id} step={step} />
          ))}
        </div>
      )}
      {message.content && <div className="chat-bubble">{message.content}</div>}
      {message.status === 'streaming' && live && !message.content && (
        <div className="chat-bubble chat-thinking">正在思考…</div>
      )}
      {message.status === 'streaming' && live && message.content && (
        <span className="chat-cursor" aria-hidden="true" />
      )}
      {interrupted && (
        <div className="chat-error-note" role="alert">
          <AlertTriangle size={13} />
          <span>{message.error || '回复中断'}</span>
        </div>
      )}
      {message.case_id && (
        <button
          type="button"
          className="chat-case-link"
          onClick={() => onOpenCase(message.case_id as string)}
        >
          <span>已生成诊断案例</span>
          <ArrowRight size={13} />
        </button>
      )}
      <time className="chat-message-time">
        {formatDate(message.created_at)}
        {message.input_tokens != null && (
          <span className="chat-message-usage" title="本轮 token 用量（输入 / 输出）与花费估算">
            ↑{formatTokens(message.input_tokens)}
            {message.output_tokens != null && ` ↓${formatTokens(message.output_tokens)}`}
            {cost && ` ≈ ${cost}`}
          </span>
        )}
      </time>
    </div>
  );
}

export function ChatThread({
  conversation,
  sending,
  composerDisabled,
  promotePending,
  modelStatus,
  contextWindows,
  modelPrices,
  onSend,
  onStop,
  onPromote,
  onOpenCase,
  onModelChange,
}: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const fetchingModels = useRef(false);
  const messageCount = conversation.messages.length;
  const lastMessage = conversation.messages.at(-1);
  const canPromote = conversation.messages.some(
    (message) => message.role === 'assistant' && message.status === 'completed',
  );

  const activeModelName = useMemo(() => {
    const override = conversation.model_override;
    if (override) return override.split(':').pop() || override;
    return modelStatus.model_name || '';
  }, [conversation.model_override, modelStatus.model_name]);

  const contextUsage = useMemo(() => {
    const lastWithUsage = [...conversation.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.input_tokens != null);
    if (!lastWithUsage?.input_tokens) return null;
    const window =
      (activeModelName ? contextWindows[activeModelName] : undefined) ??
      (activeModelName ? inferContextWindow(activeModelName) : undefined);
    return { tokens: lastWithUsage.input_tokens, window };
  }, [conversation.messages, activeModelName, contextWindows]);

  const sessionCost = useMemo(() => {
    const total = conversation.messages
      .filter((message) => message.role === 'assistant' && message.input_tokens != null)
      .reduce(
        (sum, message) =>
          sum +
          (estimateCost(
            message.input_tokens,
            message.output_tokens,
            activeModelName,
            modelPrices,
          ) ?? 0),
        0,
      );
    return total > 0 ? total : null;
  }, [conversation.messages, activeModelName, modelPrices]);

  const loadModels = () => {
    if (!modelStatus.configured || fetchingModels.current) return;
    fetchingModels.current = true;
    void api
      .availableModels()
      .then((models) => setAvailableModels(models))
      .catch(() => {
        // 拉取失败时选择器仅显示当前模型，不影响聊天
      })
      .finally(() => {
        fetchingModels.current = false;
      });
  };

  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelStatus.configured, modelStatus.provider]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messageCount, lastMessage?.content, lastMessage?.steps.length]);

  const modelOptions = useMemo(() => {
    const options = new Set(availableModels);
    if (modelStatus.model_name) options.add(modelStatus.model_name);
    if (activeModelName) options.add(activeModelName);
    return [...options];
  }, [availableModels, modelStatus.model_name, activeModelName]);

  const toolbarExtra = (
    <>
      {modelStatus.configured && (
        <Select
          className="chat-model-select"
          showSearch
          value={conversation.model_override || ''}
          onChange={(value) => onModelChange(String(value))}
          onFocus={() => {
            // 打开下拉时如果列表为空（首次拉取失败/未完成），自动重试
            if (availableModels.length === 0) loadModels();
          }}
          options={[
            {
              value: '',
              label: `默认 · ${modelStatus.model_name}`,
            },
            ...modelOptions
              .filter((name) => name !== modelStatus.model_name)
              .map((name) => ({ value: name, label: name })),
          ]}
          aria-label="会话模型"
        />
      )}
      {sessionCost != null && (
        <span
          className="chat-context-usage"
          title="本次会话累计花费估算（按当前模型参考价，不含缓存折扣与套餐价）"
        >
          本会话 ≈ {formatCost(sessionCost)}
        </span>
      )}
      {contextUsage && (
        <span
          className="chat-context-usage"
          title="上下文占用（最近一轮请求的输入 tokens，含历史消息与工具结果）"
        >
          上下文占用 {formatTokens(contextUsage.tokens)}
          {contextUsage.window
            ? ` / ${formatTokens(contextUsage.window)}（${Math.min(
                  999,
                  Math.round((contextUsage.tokens / contextUsage.window) * 100),
                )}%）`
            : ''}
        </span>
      )}
    </>
  );

  return (
    <section className="chat-thread" aria-label={`会话 ${conversation.title}`}>
      <header className="chat-thread-header">
        <h2>{conversation.title}</h2>
        {conversation.repository_name && (
          <span className="chat-thread-source">
            {conversation.repository_name} @ {conversation.requested_ref}
          </span>
        )}
        {!conversation.repository_name && conversation.workspace_path && (
          <span className="chat-thread-source">{conversation.workspace_path}</span>
        )}
      </header>

      <div className="chat-messages scroll-region">
        {conversation.messages.length === 0 ? (
          <div className="chat-empty-thread">
            <MessageSquare size={26} strokeWidth={1.6} />
            <p>描述你遇到的 HarmonyOS 问题，助手会按需加载技能、检索代码并逐步分析。</p>
          </div>
        ) : (
          conversation.messages.map((message, index) =>
            message.role === 'user' ? (
              <div key={message.id} className="chat-message chat-message-user">
                <div className="chat-bubble">{message.content}</div>
                <time className="chat-message-time">{formatDate(message.created_at)}</time>
              </div>
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                live={sending && index === conversation.messages.length - 1}
                cost={(() => {
                  const value = estimateCost(
                    message.input_tokens,
                    message.output_tokens,
                    activeModelName,
                    modelPrices,
                  );
                  return value != null && value > 0 ? formatCost(value) : null;
                })()}
                onOpenCase={onOpenCase}
              />
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      <ChatComposer
        disabled={composerDisabled}
        sending={sending}
        canPromote={canPromote}
        promotePending={promotePending}
        toolbarExtra={toolbarExtra}
        onSend={onSend}
        onStop={onStop}
        onPromote={onPromote}
      />
    </section>
  );
}
