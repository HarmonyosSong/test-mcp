import type { ChatConversation } from '../types';

/** 会话是否有仍在途的服务端协查（status=sent 即已发出、远端尚未落地终态）。
 *  用于页面刷新/切换会话回来后恢复「协查中」提示并驱动轮询收敛。 */
export function hasPendingFollowup(conversation: Pick<ChatConversation, 'consultations'>): boolean {
  return (conversation.consultations ?? []).some((item) => item.status === 'sent');
}
