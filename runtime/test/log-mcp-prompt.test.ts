import assert from 'node:assert/strict';
import test from 'node:test';

import { LOG_MCP_TOOL_NAMES } from '../src/model/metadata.js';
import { remoteLogAvailabilityNotice } from '../src/diagnosis/remote-log-prompt.js';

test('LOG_MCP_TOOL_NAMES 覆盖日志中心、云日志与聚合工具', () => {
  assert.ok(LOG_MCP_TOOL_NAMES.includes('search_both_logs'));
  assert.ok(LOG_MCP_TOOL_NAMES.includes('query'));
  assert.ok(LOG_MCP_TOOL_NAMES.includes('cloud_search'));
  assert.equal(LOG_MCP_TOOL_NAMES.length, 14);
});

test('远程日志可用时不插入不可用声明；不可用时提醒勿声称已查', () => {
  assert.equal(remoteLogAvailabilityNotice(new Set(['search_both_logs'])), '');
  assert.equal(remoteLogAvailabilityNotice(new Set(['query', 'load_skill'])), '');
  assert.match(
    remoteLogAvailabilityNotice(new Set(['lookup_issue', 'load_skill'])),
    /远程日志工具不可用/,
  );
});
