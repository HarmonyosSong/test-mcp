import type { AguiEvent } from './events';

export interface InvestigationProgress {
  text: string;
  state: 'active' | 'waiting';
}

/** 把编排事件转换成面向使用者的进度，不暴露内部技术路由。 */
export function investigationProgressForEvent(
  event: AguiEvent,
): InvestigationProgress | null {
  switch (event.type) {
    case 'INVESTIGATION_PLAN':
      return {
        text: event.resumed ? '正在继续排查' : '正在检查应用',
        state: 'active',
      };
    case 'BRANCH_STATUS':
      if (event.status === 'running') {
        return {
          text: event.branch === 'server' ? '正在请求 Compass 协助排查' : '正在检查应用',
          state: 'active',
        };
      }
      if (event.status === 'failed') {
        return { text: '部分检查未完成，正在整理已有结果', state: 'active' };
      }
      return { text: '正在整理结论', state: 'active' };
    case 'EXTERNAL_CONSULTATION_REQUIRED':
      return { text: '需要你确认是否发送协查信息', state: 'waiting' };
    case 'JOINT_ASSESSMENT':
      return { text: '正在整理结论', state: 'active' };
    default:
      return null;
  }
}
