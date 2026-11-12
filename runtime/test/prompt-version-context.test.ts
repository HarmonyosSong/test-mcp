import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PromptVersionContextError,
  resolvePromptSourceContext,
} from '../src/capabilities/prompt-version-context.js';

test('从用户提示词读取平台、产品线和精确版本', () => {
  assert.deepEqual(resolvePromptSourceContext('Android 学而思 7.106.5 build 55364 的问题', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
  }), {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: null,
    version: '7.106.5',
    build: '55364',
  });
});

test('提示词没有版本时沿用会话端上下文，让登记表选择最新版本', () => {
  assert.deepEqual(resolvePromptSourceContext('请排查英语绘本阅读排行榜接口问题', {
    platform: 'ios',
    product_line: 'xuejiayun',
    form_factor: 'phone',
    version: null,
    build: null,
  }), {
    platform: 'ios',
    productLine: 'xuejiayun',
    formFactor: 'phone',
    version: null,
    build: null,
  });
});

test('提示词版本有歧义时拒绝自动绑定', () => {
  assert.throws(
    () => resolvePromptSourceContext('7.106.4 升级到 7.106.5 后出现问题', {
      platform: 'android',
      product_line: 'xueersi',
      form_factor: null,
      version: null,
      build: null,
    }),
    (error: unknown) => error instanceof PromptVersionContextError && /版本号/.test(error.message),
  );
});

test('提示词没有端和版本时使用已关联 LogCenter 事实补齐上下文', () => {
  assert.deepEqual(resolvePromptSourceContext('请排查学而思英语绘本问题', {
    platform: null,
    product_line: 'xueersi',
    form_factor: null,
    version: null,
    build: null,
    evidence_state: {
      entries: [{
        observation_context: {
          environment: 'prod',
          storage_alias: 'prod-android',
          account: 'account',
          collection: 'collection',
          store_id: 'store',
          topic: 'topic',
          appid: 'appid',
          query: 'learner_id',
          start: 1,
          end: 2,
          page: 1,
          entry_id: 'log-0123456789abcdef01234567',
          redaction_version: 'v1',
          matched_identifiers: [{ kind: 'learner_id', matched: true }],
          matched_error_features: [],
          service_binding: { status: 'confirmed', method: 'observed_client_session' },
          observed_platform: 'android',
          observed_version: '7.106.5',
          device_ref: null,
          session_ref: 'session-1',
          platform_conflict: false,
        },
      }],
    },
  }), {
    platform: 'android',
    productLine: 'xueersi',
    formFactor: null,
    version: '7.106.5',
    build: null,
  });
});

test('先记录提示词里的部分上下文，等待 LogCenter 补齐端后再绑定', () => {
  assert.deepEqual(resolvePromptSourceContext('请排查学而思的登录问题', {
    platform: null,
    product_line: null,
    form_factor: null,
    version: null,
    build: null,
  }), {
    platform: null,
    productLine: 'xueersi',
    formFactor: null,
    version: null,
    build: null,
  });
});
