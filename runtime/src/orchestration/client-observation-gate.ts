import type { ClientInvestigationStep } from './plan.js';

const SOURCE_TOOLS = new Set([
  'list_project_files',
  'search_project_text',
  'read_project_file',
  'load_business_context',
]);

export type ClientObservationStatus = 'not_required' | 'pending' | 'completed' | 'degraded';

type ExecutableTool = { execute?: (...args: any[]) => any };

/**
 * 客户端分支的执行门禁：知识问答可以直接结束，但读取源码前必须先尝试现场观察。
 * 日志目录不覆盖、查询失败或空结果只代表降级，不代表平台已经得到确认。
 */
export class ClientObservationGate {
  private status: ClientObservationStatus;

  constructor(
    clientSteps: readonly ClientInvestigationStep[] | undefined,
    remoteLogToolsAvailable: boolean,
  ) {
    const required = clientSteps?.[0] === 'observe'
      && clientSteps.includes('source')
      && remoteLogToolsAvailable;
    this.status = required ? 'pending' : 'not_required';
  }

  get observationStatus(): ClientObservationStatus {
    return this.status;
  }

  get sourceAllowed(): boolean {
    return this.status !== 'pending';
  }

  wrap<T extends ExecutableTool>(name: string, tool: T): T {
    if (!tool.execute) return tool;
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>, context: unknown) => {
        if (SOURCE_TOOLS.has(name) && !this.sourceAllowed) {
          throw new Error(
            'client_observation_required: 请先执行 discover_client_sessions，或按用户原文执行 resolve_log_target 后查询日志；'
            + '目录不覆盖、空结果、身份未匹配或查询失败后可以降级检查源码，但必须保留“实际平台尚未由现场日志确认”的限制。',
          );
        }
        try {
          const result = await execute(args, context);
          if (name === 'resolve_log_target' && this.status === 'pending') {
            const status = typeof result === 'object' && result !== null && 'status' in result
              ? result.status
              : undefined;
            if (status === 'not_found') this.status = 'degraded';
          } else if (name === 'parse_hilog' && this.status === 'pending') {
            this.status = 'completed';
          } else if (name === 'search_cloud_logs' && this.status === 'pending') {
            const correlated = typeof result === 'object' && result !== null
              && 'observation_status' in result && result.observation_status === 'correlated';
            this.status = correlated ? 'completed' : 'degraded';
          } else if (name === 'discover_client_sessions' && this.status === 'pending') {
            const resolved = typeof result === 'object' && result !== null
              && 'status' in result && result.status === 'resolved'
              && 'candidates' in result && Array.isArray(result.candidates)
              && result.candidates.some((candidate: unknown) => typeof candidate === 'object' && candidate !== null
                && 'entries' in candidate && Array.isArray(candidate.entries) && candidate.entries.length > 0);
            this.status = resolved ? 'completed' : 'degraded';
          }
          return result;
        } catch (error) {
          if (['resolve_log_target', 'search_cloud_logs', 'discover_client_sessions', 'parse_hilog'].includes(name)
              && this.status === 'pending') {
            this.status = 'degraded';
          }
          throw error;
        }
      },
    } as T;
  }
}
