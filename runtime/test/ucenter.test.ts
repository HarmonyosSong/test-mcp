import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UcenterClient,
  createLearnerLookupTools,
  looksLikeLearnerCard,
  lookupLearnerByCard,
} from '../src/capabilities/ucenter.js';
import { extractClientIdentity } from '../src/orchestration/client-identity.js';
import { loadRuntimeConfig } from '../src/config.js';

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

test('lookupLearnerByCard：编号查档案；短 uid / 非法输入拒绝', async () => {
  const client = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      rlt: true,
      data: {
        id: 5570040,
        card: '184010299547',
        username: '小萝卜',
        gradeName: '二年级',
        areaCode: '010',
        studentId: 'sid-1',
      },
    }), { status: 200 }),
  });
  const ok = await lookupLearnerByCard(client, '184010299547');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.learner?.uid, '5570040');
  assert.equal(ok.learner?.username, '小萝卜');
  assert.equal(ok.learner?.gradeName, '二年级');

  const invalid = await lookupLearnerByCard(client, '5570040');
  assert.equal(invalid.status, 'invalid_request');
  assert.equal(invalid.learner, null);

  const missing = new UcenterClient({
    baseUrl: 'https://ucenter.example.test',
    fetchImpl: async () => new Response(JSON.stringify({
      rlt: false,
      message: 'ucenter 未找到该学员',
      data: null,
    }), { status: 200 }),
  });
  const notFound = await lookupLearnerByCard(missing, '184010299547');
  assert.equal(notFound.status, 'not_found');
});

test('createLearnerLookupTools 挂载 lookup_learner 并可执行', async () => {
  const tools = createLearnerLookupTools(
    loadRuntimeConfig({
      HARMONY_AGENT_UCENTER_BASE_URL: 'https://ucenter.example.test',
    }),
    {
      fetchImpl: async () => new Response(JSON.stringify({
        rlt: true,
        data: { id: 1, card: '184010299547', username: '测' },
      }), { status: 200 }),
    },
  );
  assert.ok(tools?.lookup_learner);
  const result = await tools!.lookup_learner.execute!(
    { learner_id: '184010299547' },
    {} as never,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.learner?.uid, '1');
});
