/** Minimal Yach OAPI client for private markdown replies and progress cards. */

export const IM_MESSAGE_LIMIT = 4000;

export class YachAPIError extends Error {
  constructor(message = 'Yach platform request failed') {
    super(message);
    this.name = 'YachAPIError';
  }
}

export function validateYachEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Yach endpoint must be an explicit HTTPS URL without credentials/query');
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Yach endpoint must be an explicit HTTPS URL without credentials/query');
  }
  return url.replace(/\/+$/, '');
}

export interface YachOAPIConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  versionArea?: string;
  fetchImpl?: typeof fetch;
}

export interface YachSendTarget {
  toId: string;
  conversationType: '1' | '2';
}

type JsonObject = Record<string, unknown>;

export class YachOAPI {
  readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly versionArea: string;
  private readonly fetchImpl: typeof fetch;
  private token = '';
  private expires = 0;
  private tokenLock: Promise<void> = Promise.resolve();

  constructor(config: YachOAPIConfig) {
    this.baseUrl = validateYachEndpoint(config.baseUrl);
    this.appKey = config.appKey;
    this.appSecret = config.appSecret;
    this.versionArea = config.versionArea?.trim() || 'YachAreaRed';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, init: RequestInit & { params?: Record<string, string> } = {}): Promise<JsonObject> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(init.params ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = new Headers(init.headers);
    headers.set('yach-version-area', this.versionArea);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new YachAPIError('Yach request failed');
    }
    if (response.status !== 200) throw new YachAPIError('Yach HTTP request failed');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 1024 * 1024) throw new YachAPIError('Yach response size exceeded');
    let result: unknown;
    try {
      result = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new YachAPIError('Yach request failed');
    }
    if (!result || typeof result !== 'object' || (result as JsonObject).code !== 200) {
      throw new YachAPIError('Yach platform request failed');
    }
    return result as JsonObject;
  }

  private async accessToken(): Promise<string> {
    let release!: () => void;
    const previous = this.tokenLock;
    this.tokenLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.token && Date.now() / 1000 < this.expires) return this.token;
      const result = await this.request('GET', '/gettoken', {
        params: { appkey: this.appKey, appsecret: this.appSecret },
      });
      const obj = result.obj;
      if (!obj || typeof obj !== 'object') throw new YachAPIError('Yach token response invalid');
      const token = (obj as JsonObject).access_token;
      const expiry = (obj as JsonObject).expired_time;
      if (typeof token !== 'string' || !token || typeof expiry !== 'number' || expiry <= Date.now() / 1000) {
        throw new YachAPIError('Yach token response invalid');
      }
      this.token = token;
      this.expires = Math.max(Date.now() / 1000, expiry - 180);
      return this.token;
    } finally {
      release();
    }
  }

  async sendMarkdown(target: YachSendTarget, text: string, title = '诊断助手'): Promise<void> {
    if (text.length > IM_MESSAGE_LIMIT) throw new Error('Yach message exceeds single-message limit');
    const token = await this.accessToken();
    const group = target.conversationType === '2';
    const path = group ? '/group/robot/message/send' : '/v1/single/message/send';
    const message = JSON.stringify({
      msgtype: 'markdown',
      markdown: { title, text },
    });
    const body = new URLSearchParams({
      [group ? 'group_id' : 'to_user_id']: target.toId,
      message,
    });
    await this.request('POST', path, {
      params: { access_token: token },
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async createCard(target: YachSendTarget): Promise<string> {
    const result = await this.request('POST', '/openapi/v2/msg_card/create', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: await this.accessToken(),
        to_id: target.toId,
        session_type: Number(target.conversationType),
      }),
    });
    const obj = result.obj;
    const value = obj && typeof obj === 'object' ? (obj as JsonObject).msg_id : undefined;
    if (typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number') || !String(value)) {
      throw new YachAPIError('Yach card response invalid');
    }
    return String(value);
  }

  async pushCard(cardId: string, content: string): Promise<void> {
    await this.request('POST', '/openapi/v2/msg_content/push', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: await this.accessToken(),
        msg_id: cardId,
        msg_content: content,
      }),
    });
  }

  async closeCard(cardId: string): Promise<void> {
    await this.request('POST', '/openapi/v2/msg_card/close', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: await this.accessToken(),
        msg_id: cardId,
      }),
    });
  }
}
