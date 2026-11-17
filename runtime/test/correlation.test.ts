import assert from 'node:assert/strict';
import test from 'node:test';

// 编排路由退役后，请求关联标识提取迁移到 client-identity（供日志 trace_id/request_id 关联）。
import { extractCorrelationContext } from '../src/orchestration/client-identity.js';

test('从问题中提取显式 traceId/requestId，订单号不冒充请求关联', () => {
  assert.deepEqual(extractCorrelationContext('接口 500，traceId=trace-123'), { traceId: 'trace-123' });
  assert.deepEqual(extractCorrelationContext('请求 ID：req_456'), { requestId: 'req_456' });
  assert.deepEqual(extractCorrelationContext('订单号 123456，支付失败'), {});
});
