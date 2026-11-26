import type { ObservationRegistry } from './observations.js';

/**
 * 最终答案校验器：去编排化后替代 submit_diagnosis_report 硬契约。
 *
 * 只校验五件机器可判的事，其余（结论质量、证据充分性）交给 skills 指引与评测：
 * 1. 回答非空且不只是阶段说明；
 * 2. 无 DSML/工具协议文本泄露（代码块内豁免——讨论协议语法是合法内容）；
 * 3. 文中引用的 ev-ID 必须真实存在于观测注册表（防编造，存在性而非逐字摘录校验）；
 * 4. 含「判定：」锚点行（verdict 的文本载体，下游日志/知音楼/eval 从它解析）；
 * 5. 声称「已发起/进行中」的服务端协查必须真的调用了协查工具（防「嘴上说协查」）。
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
/** 信息查询里「无设备 / 未登录」类空结论；须双侧日志覆盖后才允许写。 */
const EMPTY_DEVICE_CLAIM =
  /最近\s*[37]\s*天未登录|暂无.{0,24}(登录|设备)|无近\s*[37]\s*天.{0,12}(登录|设备)|未检索到.{0,24}(登录|设备)|无法给出近\s*[37]\s*天的设备/;
/** 「协查已发起/进行中」类表述：命中而本轮未真调协查工具时拦截——防止把「发起协查」当叙述写。 */
const FOLLOWUP_CLAIM =
  /(?:已|一并|同时)[\s\S]{0,30}?(?:发起|提交)(?:了)?(?:后台)?(?:服务端)?协查|协查进行中|协查结果[\s\S]{0,12}(?:同步|推送|补充)/;
/** 真正发起协查的两个工具：同步 consult_compass 与后台 request_compass_followup。 */
const CONSULT_TOOL_NAMES = new Set(['request_compass_followup', 'consult_compass']);
/** 纯数字且 ≥11 位，按本项目约定视为学员编号/card，不是 uid。 */
const CARD_LIKE_QUERY = /^\d{11,}$/;
const UID_LIKE_QUERY = /^\d{1,10}$/;

/** 设备结论要求双侧：search_both_logs 且带 cloud 参数（不带只查日志中心），或 cloud_search + query。 */
export function hasBilateralDeviceLogCoverage(
  calledTools: ReadonlySet<string> | readonly string[],
  searchBothWithCloud = false,
): boolean {
  const called = calledTools instanceof Set ? calledTools : new Set(calledTools);
  if (called.has('search_both_logs') && searchBothWithCloud) return true;
  return called.has('cloud_search') && called.has('query');
}

export type FinalAnswerValidationContext = {
  /** 本轮（含校验重试）已发起的工具名；信息查询空设备结论依赖它。 */
  calledTools?: ReadonlySet<string> | readonly string[];
  /** 本轮日志工具实际使用的 query 字符串（顶层或 cloud.query）。 */
  logQueries?: readonly string[];
  /** 本轮 search_both_logs 是否至少有一次带 cloud 参数（不带只查日志中心单侧）。 */
  searchBothWithCloud?: boolean;
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

  const called = context.calledTools
    ? context.calledTools instanceof Set
      ? context.calledTools
      : new Set(context.calledTools)
    : new Set<string>();

  // 声称协查已发起/进行中，本轮却未调用协查工具：打回，要么真调，要么删表述。
  if (FOLLOWUP_CLAIM.test(withoutCode) && ![...CONSULT_TOOL_NAMES].some((name) => called.has(name))) {
    return {
      ok: false,
      feedback:
        '回答声称已发起服务端协查（「已发起/提交协查」「协查进行中」「协查结果稍后同步」），但本轮并未调用 request_compass_followup 或 consult_compass。要么现在真正调用协查工具再收尾，要么删掉协查相关表述、如实写明本地证据缺口与「未协查」。禁止声称一个不存在的协查。',
    };
  }

  if (verdict === 'info_lookup' && EMPTY_DEVICE_CLAIM.test(withoutCode)) {
    if (!hasBilateralDeviceLogCoverage(called, context.searchBothWithCloud ?? false)) {
      return {
        ok: false,
        feedback:
          '信息查询写了「未登录/暂无设备线索」，但本轮尚未双侧覆盖日志（须 search_both_logs 且带 cloud 参数（如 cloud={}），或 cloud_search + query）。请用学员 uid 裸数字查近 3 天两侧日志再写设备段；若 log-mcp 不可用，写「设备侧暂不可查」，不要写「未登录」。',
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
