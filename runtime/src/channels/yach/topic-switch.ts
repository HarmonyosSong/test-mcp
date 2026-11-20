/**
 * 群聊话题切换检测：强信号命中即开新会话，避免旧上下文扰乱新问题。
 *
 * 群里多人多话题，会话历史与群历史摘要都会灌进 prompt；旧话题的学员/uid/结论
 * 很容易被模型张冠李戴。追问场景必须保住（指代依赖上下文），所以只用强信号：
 *
 * - 显式换题词开头（"新问题"/"另外"/"还有一个"……）→ 切
 * - 当前消息含学员编号/uid：与历史无交集 → 切；有交集 → 不切（同学员追问，超时也不切）
 * - 当前消息不含编号且距会话最近活动超 30 分钟 → 切（群里隔了半天的无指代新消息）
 *
 * 偏弱信号一律不切：宁可在同一会话里多问几句，也不丢追问上下文。
 */

const TOPIC_GAP_MS = 30 * 60 * 1_000;

/** 消息开头的换题词。 */
const SWITCH_PREFIX = /^\s*(新问题|换个问题|另外一个|另外|还有一个|再帮[我忙]?看|再查[一下个]?|重新查|重新看)/;

/** 学员编号：12 位数字。 */
const STUDENT_ID = /\d{12}/g;
/** uid 显式写法（uid 2592373 / uid:2592373）；裸数字不算，误伤面太大。 */
const UID_EXPLICIT = /uid\s*[:：#]?\s*(\d{5,10})/gi;

function identifiersOf(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(STUDENT_ID)) ids.add(`card:${match[0]}`);
  for (const match of text.matchAll(UID_EXPLICIT)) ids.add(`uid:${match[1]}`);
  return ids;
}

export interface TopicSwitchInput {
  text: string;
  /** 会话历史里的用户消息原文（用于提取历史学员编号/uid）。 */
  historyUserTexts: string[];
  /** 会话最近活动时间（ISO 字符串）；协查回执等系统消息也会刷新它。 */
  conversationUpdatedAt: string;
  now?: number;
}

export function isTopicSwitch(input: TopicSwitchInput): boolean {
  const text = input.text.trim();
  if (!text) return false;

  // 1. 显式换题词。
  if (SWITCH_PREFIX.test(text)) return true;

  const current = identifiersOf(text);
  if (current.size > 0) {
    // 2. 编号信号：与历史无交集是强换题；有交集则同学员追问，超时也不切。
    const history = new Set<string>();
    for (const past of input.historyUserTexts) {
      for (const id of identifiersOf(past)) history.add(id);
    }
    for (const id of current) {
      if (history.has(id)) return false;
    }
    return true;
  }

  // 3. 无编号新消息：超时间隔才算换题（追问通常紧跟）。
  const last = Date.parse(input.conversationUpdatedAt);
  const now = input.now ?? Date.now();
  if (Number.isFinite(last) && now - last > TOPIC_GAP_MS) return true;
  return false;
}
