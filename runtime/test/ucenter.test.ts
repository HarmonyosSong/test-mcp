import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UcenterClient,
  applyResolvedUidQuery,
  looksLikeLearnerCard,
  resolveLearnerUid,
} from '../src/capabilities/ucenter.js';
import { extractClientIdentity } from '../src/orchestration/client-identity.js';

test('学员编号标签记为 card，uid 标签记为 uid', () => {
  assert.deepEqual(extractClientIdentity('学员编号：233021794099'), {
    learnerId: '233021794099',
    learnerIdSource: 'card',
  });
  assert.deepEqual(extractClientIdentity('uid: 17524748'), {
    learnerId: '17524748',
    learnerIdSource: 'uid',
  });
});

test('口语「用户/该用户/改用户+数字」也能抽出身份：短号当 uid，长号当 card', () => {
  assert.deepEqual(extractClientIdentity('查下改用户17524748近期登录的学而思App版本'), {
    learnerId: '17524748',
    learnerIdSource: 'uid',
  });
  assert.deepEqual(extractClientIdentity('查该用户 233021794099 的日志'), {
    learnerId: '233021794099',
    learnerIdSource: 'card',
  });
});

test('looksLikeLearnerCard 只认纯数字编号', () => {
  assert.equal(looksLikeLearnerCard('233021794099'), true);
  assert.equal(looksLikeLearnerCard('17524748'), true);
  assert.equal(looksLikeLearnerCard('student-fixture-001'), false);
});

test('getUserByCard 取 data.id 为 uid，并校验 card 回显', async () => {
  const calls: string[] = [];
  const client = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    timeoutMs: 1000,
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        rlt: true,
        code: '000000',
        message: 'ok',
        data: {
          id: 17524748,
          card: '233021794099',
          studentId: 'abc',
          username: '沈新',
        },
      }), { status: 200 });
    },
  });
  const user = await client.getUserByCard('233021794099');
  assert.equal(user.uid, '17524748');
  assert.equal(user.card, '233021794099');
  assert.match(calls[0]!, /card=233021794099/);
});

test('card 回显不一致或空 data 时失败', async () => {
  const client = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      rlt: true,
      data: { id: 1, card: '999' },
    }), { status: 200 }),
  });
  await assert.rejects(() => client.getUserByCard('233021794099'), /card/i);
});

test('resolveLearnerUid：card 转 uid；已是 uid 原样返回；转换失败返回 null', async () => {
  const client = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      rlt: true,
      data: { id: 17524748, card: '233021794099' },
    }), { status: 200 }),
  });
  assert.equal(await resolveLearnerUid({ learnerId: '17524748', learnerIdSource: 'uid' }, client), '17524748');
  assert.equal(
    await resolveLearnerUid({ learnerId: '233021794099', learnerIdSource: 'card' }, client),
    '17524748',
  );
  assert.equal(
    await resolveLearnerUid({ learnerId: 'student-fixture-001', learnerIdSource: 'card' }, client),
    null,
  );
  const failing = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    fetchImpl: async () => new Response(JSON.stringify({ rlt: false, data: null }), { status: 200 }),
  });
  assert.equal(
    await resolveLearnerUid({ learnerId: '233021794099', learnerIdSource: 'card' }, failing),
    null,
  );
});

test('applyResolvedUidQuery 强制带上转换后的 uid，并替换错误 uid 子句', () => {
  assert.equal(applyResolvedUidQuery(undefined, '17524748'), 'uid: "17524748"');
  assert.equal(applyResolvedUidQuery('*', '17524748'), 'uid: "17524748"');
  assert.equal(applyResolvedUidQuery('uid:233021794099', '17524748'), 'uid: "17524748"');
  assert.equal(applyResolvedUidQuery('uid: "233021794099"', '17524748'), 'uid: "17524748"');
  assert.equal(
    applyResolvedUidQuery('level:ERROR AND uid:233021794099', '17524748'),
    '(level:ERROR) AND uid: "17524748"',
  );
  assert.equal(
    applyResolvedUidQuery('message:quiz', '17524748'),
    '(message:quiz) AND uid: "17524748"',
  );
  assert.equal(applyResolvedUidQuery('message:quiz', undefined), 'message:quiz');
});
