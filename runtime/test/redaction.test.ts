import assert from 'node:assert/strict';
import test from 'node:test';

import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../src/security/redaction.js';

test('不脱敏：Bearer、密钥参数与环境变量密钥值全部原样保留', () => {
  const result = redactSensitiveText(
    'Authorization: Bearer opaque-token api_key=opaque-token other=ok opaque-token',
    { SERVICE_ACCESS_TOKEN: 'opaque-token' },
  );
  assert.equal(result.includes('opaque-token'), true);
  assert.match(result, /Bearer opaque-token/);
  assert.match(result, /api_key=opaque-token/);
  assert.match(result, /other=ok/);
});

test('redacts strings recursively from persisted records', () => {
  const value = redactRecord({ content: 'key=local-secret', nested: [{ excerpt: 'local-secret' }] }, (text) => text.replaceAll('local-secret', '[REDACTED]'));
  assert.deepEqual(value, {
    content: 'key=[REDACTED]',
    nested: [{ excerpt: '[REDACTED]' }],
  });
});

test('redacts records in place without replacing nested object identities', () => {
  const message = { content: 'local-secret' };
  const record = { messages: [message] };
  redactRecordInPlace(record, (text) => text.replaceAll('local-secret', '[REDACTED]'));
  assert.equal(record.messages[0], message);
  assert.equal(message.content, '[REDACTED]');
});
