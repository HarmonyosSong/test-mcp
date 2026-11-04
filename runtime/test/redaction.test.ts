import assert from 'node:assert/strict';
import test from 'node:test';

import { redactRecord, redactRecordInPlace, redactSensitiveText } from '../src/security/redaction.js';

test('redacts bearer headers, secret query parameters, and configured secret environment values', () => {
  const result = redactSensitiveText(
    'Authorization: Bearer opaque-token api_key=opaque-token other=ok opaque-token',
    { SERVICE_ACCESS_TOKEN: 'opaque-token' },
  );
  assert.equal(result.includes('opaque-token'), false);
  assert.match(result, /Bearer \[REDACTED\]/);
  assert.match(result, /api_key=\[REDACTED\]/);
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
