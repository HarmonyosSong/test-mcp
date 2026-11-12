import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import {
  COMPASS_A2A_AGENT_CARD_PATH,
  COMPASS_A2A_PROTOCOL_VERSION,
  COMPASS_A2A_RPC_PATH,
} from './compass-a2a.js';
import type { ModelConfiguration } from '../model/configuration.js';

const DEBUG_SYSTEM_PROMPT = `你是本地 A2A 联调使用的统一外部全栈协查 Agent，模拟覆盖本项目前端、H5 和服务端的对端。请用中文分析培优问题排查主 Agent 发来的问题。
你只能依据消息中明确提供的事实，不得声称查询过真实前端、H5、服务端源码、日志、数据库或知识库，也不得编造接口调用结果。
请给出：可能的全栈核查方向、当前无法验证的部分、建议主 Agent 补充的关联信息。
你的回答只用于验证 A2A 协议和主 Runtime 编排，不是真实生产事故结论。`;

const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
const SendParamsSchema = z.object({
  message: z.object({
    role: z.literal('ROLE_USER'),
    messageId: z.string().min(1),
    contextId: z.string().min(1).optional(),
    parts: z.array(z.object({ text: z.string() })).min(1),
  }),
});
const CancelParamsSchema = z.object({ id: z.string().min(1) });

type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

interface DebugTask {
  id: string;
  contextId: string;
  state: TaskState;
  controller: AbortController;
  createdAt: number;
}

export interface CompassA2ADebugOptions {
  token: string;
  modelConfiguration: ModelConfiguration;
}

function bearerMatches(actual: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function taskPayload(task: DebugTask) {
  return { id: task.id, contextId: task.contextId, status: { state: task.state } };
}

/**
 * 仅本地开发使用的 A2A 叶子提供端：复用当前模型，不挂载工具，也不再发起诊断轮次。
 * 主 Runtime 仍通过 Supervisor → Compass Slot → A2A Client 调用这里。
 */
export function createCompassA2ADebugRoutes(options: CompassA2ADebugOptions): Hono {
  const routes = new Hono();
  const token = options.token.trim();
  const tasks = new Map<string, DebugTask>();

  const authorize: MiddlewareHandler = async (context, next) => {
    if (!bearerMatches(context.req.header('authorization'), token)) {
      return context.json({ detail: 'Unauthorized' }, 401);
    }
    if (context.req.header('a2a-version') !== COMPASS_A2A_PROTOCOL_VERSION) {
      return context.json({ detail: 'Unsupported A2A-Version' }, 400);
    }
    await next();
  };

  routes.get(COMPASS_A2A_AGENT_CARD_PATH, authorize, (context) => context.json({
    name: 'Peiyou Troubleshooting Local A2A Debug Provider',
    description: '本地开发协查对端；复用当前模型配置，不代表真实 Compass 调查结果。',
    version: '0.1.0',
    capabilities: { streaming: true },
    supportedInterfaces: [{
      url: new URL(COMPASS_A2A_RPC_PATH, context.req.url).toString(),
      protocolBinding: 'JSONRPC',
      protocolVersion: COMPASS_A2A_PROTOCOL_VERSION,
    }],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  }));

  routes.post(COMPASS_A2A_RPC_PATH, authorize, async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch {
      return context.json(rpcError(null, -32700, 'Parse error'));
    }
    const request = RpcRequestSchema.safeParse(body);
    if (!request.success) return context.json(rpcError(null, -32600, 'Invalid Request'));
    const { id, method } = request.data;

    if (method === 'CancelTask') {
      const params = CancelParamsSchema.safeParse(request.data.params);
      if (!params.success) return context.json(rpcError(id, -32602, 'Invalid CancelTask params'));
      const task = tasks.get(params.data.id);
      if (!task) return context.json(rpcError(id, -32001, 'Task not found'));
      if (!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.state)) {
        task.state = 'TASK_STATE_CANCELED';
        task.controller.abort();
      }
      return context.json(rpcResult(id, { task: taskPayload(task) }));
    }

    if (method !== 'SendStreamingMessage') {
      return context.json(rpcError(id, -32601, 'Method not found'));
    }
    const params = SendParamsSchema.safeParse(request.data.params);
    if (!params.success) return context.json(rpcError(id, -32602, 'Invalid SendStreamingMessage params'));
    const text = params.data.message.parts.map((part) => part.text).join('\n').trim();
    if (!text || text.length > 50_000) return context.json(rpcError(id, -32602, 'Message text is empty or too long'));

    const task: DebugTask = {
      id: randomUUID(),
      contextId: params.data.message.contextId ?? randomUUID(),
      state: 'TASK_STATE_SUBMITTED',
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    tasks.set(task.id, task);
    if (tasks.size > 256) {
      const oldest = [...tasks.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (oldest && oldest.id !== task.id && ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(oldest.state)) {
        tasks.delete(oldest.id);
      }
    }

    return streamSSE(context, async (stream) => {
      stream.onAbort(() => task.controller.abort());
      const write = async (result: unknown) => {
        await stream.writeSSE({ data: JSON.stringify(rpcResult(id, result)) });
      };
      const status = async () => {
        await write({ statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: { state: task.state },
          final: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.state),
        } });
      };
      await write({ task: taskPayload(task) });
      task.state = 'TASK_STATE_WORKING';
      await status();
      let pendingText = '';
      let artifactCount = 0;
      let producedText = false;
      const flushArtifact = async () => {
        const artifactText = pendingText.trim();
        pendingText = '';
        if (!artifactText) return;
        producedText = true;
        artifactCount += 1;
        await write({ artifactUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: {
            artifactId: `server-consultation-${artifactCount}`,
            name: '本地调试协查结果',
            parts: [{ text: artifactText }],
          },
        } });
      };
      try {
        const model = await options.modelConfiguration.languageModel();
        const output = await model.doStream({
          prompt: [
            { role: 'system', content: DEBUG_SYSTEM_PROMPT },
            { role: 'user', content: [{ type: 'text', text }] },
          ],
          maxOutputTokens: 2_000,
          abortSignal: task.controller.signal,
        });
        for await (const part of output.stream) {
          if (task.controller.signal.aborted) break;
          if (part.type === 'text-delta') {
            pendingText += part.delta;
            // 当前客户端按 artifact 分段拼接；按较大段落发送，避免 token 间被插入换行。
            if (pendingText.length >= 400) await flushArtifact();
          } else if (part.type === 'error') {
            throw part.error;
          }
        }
        if (task.controller.signal.aborted) {
          task.state = 'TASK_STATE_CANCELED';
        } else if (!producedText && !pendingText.trim()) {
          task.state = 'TASK_STATE_FAILED';
        } else {
          await flushArtifact();
          task.state = 'TASK_STATE_COMPLETED';
        }
      } catch {
        task.state = task.controller.signal.aborted ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED';
      }
      await status();
    });
  });

  return routes;
}
