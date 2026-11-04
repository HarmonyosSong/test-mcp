import type { ZodIssue } from 'zod';

function response(detail: Array<{ type: string; loc: unknown[]; msg: string }>): Response {
  return new Response(JSON.stringify({ detail }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });
}

export function requestValidationError(issues: ZodIssue[]): Response {
  return response(issues.map((issue) => ({
    type: issue.code,
    loc: ['body', ...issue.path],
    msg: issue.message,
  })));
}

export function invalidJsonError(): Response {
  return response([{ type: 'json_invalid', loc: ['body'], msg: 'invalid JSON body' }]);
}

export function queryValidationError(issues: Array<{ type: string; field: string; msg: string }>): Response {
  return response(issues.map((issue) => ({
    type: issue.type,
    loc: ['query', issue.field],
    msg: issue.msg,
  })));
}
