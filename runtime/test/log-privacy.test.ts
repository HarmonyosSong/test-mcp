import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractClientIdentity,
  extractClientIdentityFromMessages,
  hasClientIdentity,
} from '../src/orchestration/client-identity.js';
import { ClientLogPrivacy } from '../src/security/log-privacy.js';
import { createClientLogPrivacy, redactClientText } from '../src/security/client-context.js';
import { createStreamRedactor } from '../src/security/stream-redaction.js';

const identity = { learnerId: 'student-fixture-001', phone: '+8613800000000' };
const logIdentifiers = { learner_id: identity.learnerId, phone: identity.phone };

test('只提取带明确标签的学员身份，忽略工单中的普通数字', () => {
  assert.deepEqual(
    extractClientIdentity('学员编号：student-fixture-001，联系电话：138-0000-0000，版本 7.105.0'),
    { learnerId: 'student-fixture-001', phone: '13800000000' },
  );
  assert.deepEqual(extractClientIdentity('构建号 20261104210942，联系电话待补充'), {});
  assert.equal(hasClientIdentity({}), false);
  assert.equal(hasClientIdentity(identity), true);
});

test('多条用户消息按字段合并，同一身份字段以最近一次明确输入为准', () => {
  assert.deepEqual(extractClientIdentityFromMessages([
    '学员编号: old-fixture-student; 联系电话: +8613800000000',
    '补充：学员编号是 student-fixture-001',
  ]), identity);
});

test('脱敏前完成身份匹配，结果只保留匹配事实和伪名', () => {
  const privacy = new ClientLogPrivacy(logIdentifiers, Buffer.alloc(32, 7));
  const result = privacy.sanitize({
    uid: identity.learnerId,
    phone: identity.phone,
    desc: `request failed for ${identity.learnerId}; other phone 13900000000`,
    authorization: 'Bearer fixture-secret',
    nested: { token: 'fixture-token' },
  });
  assert.deepEqual(result.matched_identifiers, [
    { kind: 'learner_id', matched: true },
    { kind: 'phone', matched: true },
  ]);
  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes(identity.learnerId), false);
  assert.equal(serialized.includes('13800000000'), false);
  assert.equal(serialized.includes('13900000000'), false);
  assert.equal(serialized.includes('fixture-secret'), false);
  assert.equal(serialized.includes('fixture-token'), false);
  assert.match(serialized, /learner_id:[a-f0-9]{16}/);
  assert.match(serialized, /redacted-phone/);
});

test('日志条目 ID 基于脱敏内容，不包含原始身份', () => {
  const privacy = new ClientLogPrivacy(logIdentifiers, Buffer.alloc(32, 9));
  const first = privacy.entryId({ uid: identity.learnerId, message: 'failed' });
  const repeated = privacy.entryId({ message: 'failed', uid: identity.learnerId });
  const changed = privacy.entryId({ uid: identity.learnerId, message: 'recovered' });
  assert.equal(first, repeated);
  assert.notEqual(first, changed);
  assert.match(first, /^log-[a-f0-9]{24}$/);
  assert.equal(first.includes(identity.learnerId), false);
});

test('跨文本增量拆分标识时仍按完整文本脱敏，并保留尾部顺序', () => {
  const input = `学员编号: ${identity.learnerId}; 联系电话: 13800000000`;
  const privacy = createClientLogPrivacy([input], false);
  const redact = Object.assign(
    (text: string) => redactClientText(privacy, text),
    { sensitiveSuffixLength: (text: string) => privacy.sensitiveSuffixLength(text) },
  );
  const expected = redact(`${'前缀'.repeat(80)} ${identity.learnerId} 13800000000 尾部`);
  const stream = createStreamRedactor(redact);
  let actual = '';
  for (const delta of `${'前缀'.repeat(80)} ${identity.learnerId} 13800000000 尾部`) {
    actual += stream.push(delta);
  }
  actual += stream.flush();
  assert.equal(actual, expected);
  assert.equal(actual.includes(identity.learnerId), false);
  assert.equal(actual.includes('13800000000'), false);
  assert.equal(actual.endsWith('尾部'), true);
});

test('不同轮次密钥不能关联同一身份伪名', () => {
  const first = new ClientLogPrivacy(logIdentifiers, Buffer.alloc(32, 1));
  const second = new ClientLogPrivacy(logIdentifiers, Buffer.alloc(32, 2));
  assert.notEqual(
    first.pseudonym('learner_id', identity.learnerId),
    second.pseudonym('learner_id', identity.learnerId),
  );
});
