import type { ObservationRegistry } from './observations.js';

/**
 * 最终答案校验器：去编排化后替代 submit_diagnosis_report 硬契约。
 *
 * 只校验四件机器可判的事，其余（结论质量、证据充分性）交给 skills 指引与评测：
 * 1. 回答非空且不只是阶段说明；
 * 2. 无 DSML/工具协议文本泄露（代码块内豁免——讨论协议语法是合法内容）；
 * 3. 文中引用的 ev-ID 必须真实存在于观测注册表（防编造，存在性而非逐字摘录校验）；
 * 4. 含「判定：」锚点行（verdict 的文本载体，下游日志/知音楼/eval 从它解析）。
 *
 * 校验失败返回 feedback，由调用方追加为纠错消息让模型重答（≤2 次）。
 */

export type VerdictMarker =
  | 'located'
  | 'probable'
  | 'insufficient_evidence'
  | 'tool_error'
  | 'info_lookup';

const VERDICT_MARKERS: Record<string, VerdictMarker> = {
  已定位: 'located',
  可能定位: 'probable',
  证据不足: 'insufficient_evidence',
  工具异常: 'tool_error',
  信息查询: 'info_lookup',
};

const FENCED_CODE = /```[\s\S]*?```/g;
const TEXTUAL_TOOL_MARKUP = /<\s*\/?\s*(?:(?:[｜|]{2}DSML[｜|]{2}\s*)(?:calls|invoke|parameter)|(?:invoke|parameter))\b[^>]*>/i;
const EVIDENCE_ID_PATTERN = /\bev-(?:user-)?[0-9a-f]{12,16}\b/g;
const VERDICT_LINE = /判定\s*[:：]\s*(已定位|可能定位|证据不足|工具异常|信息查询)/;
/** 信息查询里「无设备 / 未登录」类空结论；须先调用过云日志工具才允许写。 */
const EMPTY_DEVICE_CLAIM =
  /最近\s*7\s*天未登录|暂无.{0,24}(登录|设备)|无近\s*7\s*天.{0,12}(登录|设备)|未检索到.{0,24}(登录|设备)|无法给出近\s*7\s*天的设备/;
/** 客户端设备线索在云日志；只打日志中心 query 容易假阴性。 */
const DEVICE_CLOUD_LOG_TOOLS = new Set(['search_both_logs', 'cloud_search']);
/** 纯数字且 ≥11 位，按本项目约定视为学员编号/card，不是 uid。 */
const CARD_LIKE_QUERY = /^\d{11,}$/;
const UID_LIKE_QUERY = /^\d{1,10}$/;

export type FinalAnswerValidationContext = {
  /** 本轮（含校验重试）已发起的工具名；信息查询空设备结论依赖它。 */
  calledTools?: ReadonlySet<string> | readonly string[];
  /** 本轮日志工具实际使用的 query 字符串（顶层或 cloud.query）。 */
  logQueries?: readonly string[];
};

/** 解析判定锚点；返回 null 表示缺失或不规范。 */
export function parseVerdictMarker(text: string): VerdictMarker | null {
  const match = VERDICT_LINE.exec(text);
  return match ? VERDICT_MARKERS[match[1]!] ?? null : null;
}

/**
 * 裁掉判定锚点之前的流式过程文本（「我会先…」式的步骤播报）。
 * 供只展示最终结论的渠道（知音楼 IM）使用；锚点缺失时原样返回。
 */
export function trimToVerdictAnchor(text: string): string {
  const match = VERDICT_LINE.exec(text);
  if (!match) return text;
  return text.slice(match.index).trim();
}

export type FinalAnswerCheck =
  | { ok: true; verdict: VerdictMarker }
  | { ok: false; feedback: string };

export function validateFinalAnswer(
  text: string,
  observations: Pick<ObservationRegistry, 'has' | 'get'>,
  context: FinalAnswerValidationContext = {},
): FinalAnswerCheck {
  const body = text.trim();
  if (!body) {
    return {
      ok: false,
      feedback: '当前没有输出任何回答内容。请直接给出已有证据支持的结论及必要缺口，不要只输出过程说明。',
    };
  }

  const withoutCode = body.replace(FENCED_CODE, '');
  if (TEXTUAL_TOOL_MARKUP.test(withoutCode)) {
    return {
      ok: false,
      feedback: '回答中包含文本形式的工具调用标记。请使用结构化工具调用；工具不可用时基于已有证据回答，并说明证据缺口。',
    };
  }

  const cited = new Set(withoutCode.match(EVIDENCE_ID_PATTERN) ?? []);
  const unknown = [...cited].filter((id) => !observations.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      feedback: `回答引用了不存在的观测 ID：${unknown.join('、')}。只能引用本轮或历史工具结果中实际出现的 evidence_refs/ev-user- ID；禁止自创。请移除或改为真实观测 ID 后重答。`,
    };
  }

  const verdict = parseVerdictMarker(body);
  if (!verdict) {
    return {
      ok: false,
      feedback: '回答缺少判定锚点。请在首行输出「判定：已定位|可能定位|证据不足|工具异常|信息查询」之一，再展开结论。',
    };
  }

  if (verdict === 'info_lookup' && EMPTY_DEVICE_CLAIM.test(withoutCode)) {
    const called = context.calledTools
      ? context.calledTools instanceof Set
        ? context.calledTools
        : new Set(context.calledTools)
      : new Set<string>();
    const queriedCloudLogs = [...DEVICE_CLOUD_LOG_TOOLS].some((name) => called.has(name));
    if (!queriedCloudLogs) {
      return {
        ok: false,
        feedback:
          '信息查询写了「未登录/暂无设备线索」，但本轮尚未调用 search_both_logs（需 cloud={}）或 cloud_search。请先用学员 uid 裸数字查近 7 天云日志再写设备段；若 log-mcp 不可用，写「设备侧暂不可查」，不要写「未登录」。',
      };
    }

    const queries = (context.logQueries ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    const personQueries = queries.filter((item) => CARD_LIKE_QUERY.test(item) || UID_LIKE_QUERY.test(item));
    if (
      personQueries.length > 0 &&
      personQueries.every((item) => CARD_LIKE_QUERY.test(item))
    ) {
      return {
        ok: false,
        feedback:
          '信息查询写了「未登录/暂无设备线索」，但本轮日志 query 用的是学员编号（≥11 位），客户端日志通常只有 uid。请改用档案里的 uid 裸数字重查后再写设备段。',
      };
    }
  }

  return { ok: true, verdict };
}
