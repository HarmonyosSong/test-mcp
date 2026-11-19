import { Select } from '@arco-design/web-react';
import {
  AlertTriangle,
  Check,
  Copy,
  LoaderCircle,
  MessageSquare,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatProgress } from '../../hooks/useChatSessions';
import { api } from '../../api';
import { estimateCost, formatCost, formatDate, formatTokens } from '../../format';
import type {
  ChatConversation,
  ChatMessage,
  ModelStatus,
} from '../../types';
import { AiTraceDialog } from './AiTracePanel';
import { PixelOrb } from '../PixelOrb';
import { ChatComposer } from './ChatComposer';
import { ConsultationCard } from './ConsultationCard';
import { MarkdownContent } from './MarkdownContent';
import { ReportCard } from './ReportCard';
import { ToolStepCard } from './ToolStepCard';

interface ChatThreadProps {
  conversation: ChatConversation;
  sending: boolean;
  composerDisabled: boolean;
  modelStatus: ModelStatus;
  contextWindows: Record<string, number>;
  modelPrices: Record<string, { input: number; output: number }>;
  onSend: (content: string) => void;
  onStop: () => void;
  onModelChange: (spec: string) => void;
  progress: ChatProgress | null;
}

/** 从模型名解析上下文窗口的兜底：如 k3-256k → 256k，k3-1m → 1M。 */
function inferContextWindow(modelName: string): number | undefined {
  const match = modelName.toLowerCase().match(/(?:^|[^0-9])(\d+)\s*(k|m)(?:[^0-9]|$)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2] === 'm' ? value * 1_048_576 : value * 1_024;
}

/** 用户消息气泡:支持拖选复制,也提供一键复制按钮(深色气泡上选区不明显)。 */
function UserMessage({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      // 剪贴板 API 不可用(非安全上下文)时退化为选中原文,由用户手动复制
      const selection = window.getSelection();
      const range = document.createRange();
      const node = document.getElementById(`user-bubble-${message.id}`);
      if (selection && node) {
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="chat-message chat-message-user">
      <div className="chat-bubble-wrap">
        <div className="chat-bubble" id={`user-bubble-${message.id}`}>
          {message.content}
        </div>
        <button
          type="button"
          className="chat-copy-button"
          onClick={copyContent}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制这条消息'}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <time className="chat-message-time">{formatDate(message.created_at)}</time>
    </div>
  );
}

function AssistantMessage({
  message,
  live,
  cost,
}: {
  message: ChatMessage;
  /** 是否为本会话正在进行的回复；否则 streaming 视为中断的遗留消息 */
  live: boolean;
  /** 本轮花费估算文本；无价格数据时为 null */
  cost: string | null;
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
      {message.content && (
        <div className="chat-bubble">
          <MarkdownContent content={message.content} />
        </div>
      )}
      {message.report && <ReportCard report={message.report} />}
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
      <time className="chat-message-time">
        {formatDate(message.created_at)}
        {message.steps.length > 0 && (
          <span className="chat-message-usage" title="本轮工具调用次数">
            <Wrench size={11} />
            {message.steps.length} 次工具
          </span>
        )}
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
  modelStatus,
  contextWindows,
  modelPrices,
  onSend,
  onStop,
  onModelChange,
  progress,
}: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showTrace, setShowTrace] = useState(false);
  const fetchingModels = useRef(false);
  const messageCount = conversation.messages.length;
  const lastMessage = conversation.messages.at(-1);
  const consultations = conversation.consultations ?? [];

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
  }, [messageCount, lastMessage?.content, lastMessage?.steps.length, consultations.length, progress?.text]);

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
        <button
          type="button"
          className={`chat-trace-toggle pixel-orb-toggle${showTrace ? ' active' : ''}${progress ? ' thinking' : ''}`}
          onClick={() => setShowTrace((value) => !value)}
          title="查看 AI 输入 / 输出调试信息"
          aria-pressed={showTrace}
        >
          <PixelOrb active={!!progress} size={20} />
          <span>AI 调试</span>
        </button>
      </header>

      {showTrace && (
        <AiTraceDialog conversationId={conversation.id} onClose={() => setShowTrace(false)} />
      )}

      {progress && (
        <div className="investigation-progress investigation-progress-active" role="status">
          <LoaderCircle className="spin" size={15} aria-hidden="true" />
          <span>{progress.text}</span>
        </div>
      )}

      <div className="chat-messages scroll-region">
        {conversation.messages.length === 0 ? (
          <div className="chat-empty-thread">
            <MessageSquare size={26} strokeWidth={1.6} />
            <p>描述你遇到的培优问题，助手会按需检索知识、检查代码并自动协查。</p>
          </div>
        ) : (
          conversation.messages.map((message, index) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
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
              />
            ),
          )
        )}
        {consultations.map((consultation) => (
          <ConsultationCard key={consultation.id} consultation={consultation} />
        ))}
        <div ref={bottomRef} />
      </div>

      <ChatComposer
        disabled={composerDisabled}
        sending={sending}
        toolbarExtra={toolbarExtra}
        onSend={onSend}
        onStop={onStop}
      />
    </section>
  );
}
