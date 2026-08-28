import type { ChatConversation, ChatMessage } from '../types';
import type { AguiEvent } from './events';

function updateMessage(
  conversation: ChatConversation,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): ChatConversation {
  return {
    ...conversation,
    updated_at: new Date().toISOString(),
    messages: conversation.messages.map((message) =>
      message.id === messageId ? updater(message) : message,
    ),
  };
}

/** 聊天事件归约：TEXT/TOOL 事件做增量更新，快照类事件整体替换。 */
export function reduceChatEvent(
  current: ChatConversation | null,
  event: AguiEvent,
): ChatConversation | null {
  switch (event.type) {
    case 'RUN_STARTED':
    case 'STATE_SNAPSHOT':
    case 'RUN_FINISHED':
      return event.conversation ?? current;
    case 'TEXT_MESSAGE_CONTENT':
      if (!current || !event.message_id) return current;
      return updateMessage(current, event.message_id, (message) => ({
        ...message,
        content: message.content + event.delta,
      }));
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_END':
      if (!current || !event.message_id) return current;
      return updateMessage(current, event.message_id, (message) => {
        const exists = message.steps.some((step) => step.id === event.tool_event.id);
        return {
          ...message,
          steps: exists
            ? message.steps.map((step) =>
                step.id === event.tool_event.id ? event.tool_event : step,
              )
            : [...message.steps, event.tool_event],
        };
      });
    case 'RUN_ERROR':
      return event.conversation ?? current;
    default:
      return current;
  }
}
