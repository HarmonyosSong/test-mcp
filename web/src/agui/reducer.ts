import type { DiagnosticCase, DiagnosticStage, ToolEvent } from '../types';
import type { AguiEvent } from './events';

function upsertStage(stages: DiagnosticStage[], stage: DiagnosticStage): DiagnosticStage[] {
  const exists = stages.some((item) => item.key === stage.key);
  if (!exists) return [...stages, stage];
  return stages.map((item) => (item.key === stage.key ? { ...item, ...stage } : item));
}

function upsertToolEvent(events: ToolEvent[], toolEvent: ToolEvent): ToolEvent[] {
  const exists = events.some((item) => item.id === toolEvent.id);
  if (!exists) return [...events, toolEvent];
  return events.map((item) =>
    item.id === toolEvent.id ? { ...item, ...toolEvent } : item,
  );
}

function updateTimestamp(diagnosticCase: DiagnosticCase, timestamp: string): DiagnosticCase {
  return { ...diagnosticCase, updated_at: timestamp || diagnosticCase.updated_at };
}

export function reduceAguiEvent(
  current: DiagnosticCase | null,
  event: AguiEvent,
): DiagnosticCase | null {
  switch (event.type) {
    case 'RUN_STARTED':
    case 'STATE_SNAPSHOT':
    case 'RUN_FINISHED':
      return event.case ?? current;
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      if (!current || current.id !== event.case_id) return current;
      return updateTimestamp(
        { ...current, stages: upsertStage(current.stages, event.stage) },
        event.timestamp,
      );
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_END':
      if (!current || !event.case_id || current.id !== event.case_id) return current;
      return updateTimestamp(
        {
          ...current,
          tool_events: upsertToolEvent(current.tool_events, event.tool_event),
        },
        event.timestamp,
      );
    case 'RUN_ERROR':
      if (event.case) return event.case;
      if (!current || current.id !== event.case_id) return current;
      return updateTimestamp(
        { ...current, status: 'failed', error: event.error },
        event.timestamp,
      );
    default:
      return current;
  }
}
