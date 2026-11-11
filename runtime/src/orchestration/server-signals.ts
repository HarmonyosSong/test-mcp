import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

const ServerSignalsSchema = z.object({
  version: z.literal(1),
  serviceNames: z.array(z.string().trim().min(1)),
  apiPrefixes: z.array(z.string().trim().min(1)),
  errorCodePatterns: z.array(z.string().trim().min(1)),
}).strict();

export type ServerSignals = z.infer<typeof ServerSignalsSchema>;

export type ServerSignalMatch = {
  matched: boolean;
  labels: string[];
};

export function parseServerSignals(source: string): ServerSignals {
  const signals = ServerSignalsSchema.parse(parse(source));
  for (const pattern of signals.errorCodePatterns) {
    // 启动时即拒绝非法正则，避免运行到分流阶段才失败。
    new RegExp(pattern, 'i');
  }
  return signals;
}

export async function loadServerSignals(
  filePath = path.resolve(process.cwd(), 'contracts/server-signals.yaml'),
): Promise<ServerSignals> {
  return parseServerSignals(await readFile(filePath, 'utf8'));
}

export function matchServerSignals(question: string, signals: ServerSignals): ServerSignalMatch {
  const normalized = question.toLowerCase();
  const labels: string[] = [];

  for (const serviceName of signals.serviceNames) {
    if (normalized.includes(serviceName.toLowerCase())) {
      labels.push(`服务名:${serviceName}`);
    }
  }
  for (const apiPrefix of signals.apiPrefixes) {
    if (normalized.includes(apiPrefix.toLowerCase())) {
      labels.push(`接口前缀:${apiPrefix}`);
    }
  }
  for (const pattern of signals.errorCodePatterns) {
    const match = new RegExp(pattern, 'i').exec(question);
    if (match) labels.push(`错误码:${match[0]}`);
  }

  return { matched: labels.length > 0, labels };
}
