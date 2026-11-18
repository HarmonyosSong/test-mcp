import { LOG_MCP_TOOL_NAMES } from '../model/metadata.js';

const LOG_TOOL_NAME_SET = new Set<string>(LOG_MCP_TOOL_NAMES);

export function hasRemoteLogTools(availableTools: ReadonlySet<string>): boolean {
  for (const name of availableTools) {
    if (LOG_TOOL_NAME_SET.has(name)) return true;
  }
  return false;
}

/** 仅在本轮未挂上远程日志工具时提示；可用时不加使用限制说明。 */
export function remoteLogAvailabilityNotice(availableTools: ReadonlySet<string>): string {
  if (hasRemoteLogTools(availableTools)) return '';
  return '远程日志工具不可用；不要声称已查询远程日志。';
}
