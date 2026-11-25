import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import type { RuntimeConfig } from '../config.js';
import { cosUploadEnabled } from '../config.js';

const require = createRequire(import.meta.url);

type CosSdk = {
  putObject: (params: Record<string, unknown>) => Promise<unknown>;
  getObjectUrl: (params: Record<string, unknown>, callback: (err: Error | null, data: string) => void) => void;
};

function createCosClient(config: Pick<RuntimeConfig, 'cosSecretId' | 'cosSecretKey' | 'cosRegion'>): CosSdk {
  // cos-nodejs-sdk-v5 为 CJS。
  const COS = require('cos-nodejs-sdk-v5') as new (options: Record<string, unknown>) => CosSdk;
  return new COS({
    SecretId: config.cosSecretId,
    SecretKey: config.cosSecretKey,
    Timeout: 15_000,
  });
}

function safeOwner(owner: string): string {
  const trimmed = owner.trim() || 'anonymous';
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    return 'anonymous';
  }
  return trimmed;
}

function objectKey(prefix: string, owner: string, id: string): string {
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  return `${prefix.replace(/\/+$/, '')}/${safeOwner(owner)}/${month}/${id}.png`;
}

export type CosUploadResult = {
  key: string;
  signedUrl: string;
};

/** cos-nodejs-sdk-v5 的 getObjectUrl 回调可能返回 string，也可能返回 `{ Url }`。 */
export function extractCosSignedUrl(data: unknown): string {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const url = (data as Record<string, unknown>).Url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  throw new Error('COS getObjectUrl did not return a URL');
}

export async function uploadPngAndSign(options: {
  config: RuntimeConfig;
  owner: string;
  body: Buffer;
  filename?: string;
}): Promise<CosUploadResult> {
  const { config, owner, body } = options;
  if (!cosUploadEnabled(config)) {
    throw new Error('COS upload is not configured');
  }
  const key = objectKey(config.cosPrefix, owner, randomUUID());
  const client = createCosClient(config);
  await client.putObject({
    Bucket: config.cosBucket,
    Region: config.cosRegion,
    Key: key,
    Body: body,
    ContentType: 'image/png',
    ContentDisposition: 'inline',
    CacheControl: 'private, no-store',
  });
  const signedUrl = await new Promise<string>((resolve, reject) => {
    client.getObjectUrl(
      {
        Bucket: config.cosBucket,
        Region: config.cosRegion,
        Key: key,
        Method: 'GET',
        Sign: true,
        Expires: config.cosSignedUrlTtlSeconds,
      },
      (err, data) => {
        if (err) reject(err);
        else {
          try {
            resolve(extractCosSignedUrl(data));
          } catch (extractError) {
            reject(extractError);
          }
        }
      },
    );
  });
  return { key, signedUrl };
}
