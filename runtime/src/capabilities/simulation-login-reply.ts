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

/**
 * 出站后处理：本轮若有成功 Token，尝试 QR→COS，把 Markdown 图附到答复。
 * 任何失败只降级文本，不抛错阻断主回复。
 */
export async function enrichSimulationLoginReply(input: {
  text: string;
  messageId: string;
  owner: string;
  config: RuntimeConfig;
}): Promise<string> {
  const hits = takeSimulationLoginTokens(input.messageId);
  if (!hits.length) return input.text;

  let text = input.text;
  for (const hit of hits) {
    text = ensureTokenCodeBlock(text, hit.uid, hit.token);
  }

  if (!cosUploadEnabled(input.config)) {
    text += '\n\n二维码未能展示（图片存储未配置）。';
    return text;
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
      text += `\n\n![Token 二维码](${uploaded.signedUrl})\n`;
      anyImage = true;
    } catch (error) {
      integrationWarn('api-mcp', 'token QR upload failed', {
        uid: hit.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!anyImage) {
    text += '\n\n二维码未能展示。';
  }
  return text;
}
