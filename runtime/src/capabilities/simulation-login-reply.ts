import type { RuntimeConfig } from '../config.js';
import { cosUploadEnabled } from '../config.js';
import { uploadPngAndSign } from './cos-store.js';
import { takeSimulationLoginTokens } from './simulation-login-tokens.js';
import { tokenToQrPng } from './token-qr.js';
import { integrationWarn } from '../observability/integration-log.js';

function tokenAlreadyInText(text: string, token: string): boolean {
  return text.includes(token);
}

function ensureTokenCodeBlock(text: string, uid: string, token: string): string {
  if (tokenAlreadyInText(text, token)) return text;
  const fence = '```';
  return `${text.trimEnd()}\n\n学员 UID ${uid} Token：\n\n${fence}\n${token}\n${fence}\n`;
}

export type SimulationLoginEnrichResult = {
  /** 出站展示版：文本 + Token 代码块 + 二维码图片（签名 URL 仅出站，不落库）。 */
  outbound: string;
  /** 落库版：以 persistText 为基准补 Token 代码块；绝不含签名 URL 与二维码提示行。 */
  persist: string;
};

/**
 * 出站后处理：本轮若有成功 Token，尝试 QR→COS，把 Markdown 图附到答复。
 * 任何失败只降级文本，不抛错阻断主回复。
 *
 * 双形态契约（spec/simulation-login-token §5.3）：
 * - outbound 带签名 URL，只发给渠道/前端展示；
 * - persist 以 persistText（完整答复）为基准，只补 Token 代码块，供写库。
 *   调用方切勿把 outbound（尤其截断/格式化版）覆盖回消息正文。
 */
export async function enrichSimulationLoginReply(input: {
  text: string;
  messageId: string;
  owner: string;
  config: RuntimeConfig;
  /** 落库基准文本（如未截断的完整答复）；缺省同 text。 */
  persistText?: string;
}): Promise<SimulationLoginEnrichResult> {
  const base = input.persistText ?? input.text;
  const hits = takeSimulationLoginTokens(input.messageId);
  if (!hits.length) return { outbound: input.text, persist: base };

  let outbound = input.text;
  let persist = base;
  for (const hit of hits) {
    outbound = ensureTokenCodeBlock(outbound, hit.uid, hit.token);
    persist = ensureTokenCodeBlock(persist, hit.uid, hit.token);
  }

  if (!cosUploadEnabled(input.config)) {
    outbound += '\n\n二维码未能展示（图片存储未配置）。';
    return { outbound, persist };
  }

  let anyImage = false;
  for (const hit of hits) {
    try {
      const png = await tokenToQrPng(hit.token);
      const uploaded = await uploadPngAndSign({
        config: input.config,
        owner: input.owner,
        body: png,
      });
      // 签名 URL 仅出站展示：落库消息不保留（会过期，且属临时凭据）。
      outbound += `\n\n![Token 二维码](${uploaded.signedUrl})\n`;
      anyImage = true;
    } catch (error) {
      integrationWarn('api-mcp', 'token QR upload failed', {
        uid: hit.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!anyImage) {
    outbound += '\n\n二维码未能展示。';
  }
  return { outbound, persist };
}
