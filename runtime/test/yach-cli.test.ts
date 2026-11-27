import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGroupDiagnosisContent,
  extractList,
  IM_MESSAGE_LIMIT,
  isYachImConfigured,
  parseCliJson,
  parseYachEvent,
  progressLabelForTool,
  summarizeGroupHistory,
  YachCli,
  YachCliError,
} from '../src/channels/yach/index.js';
import { loadRuntimeConfig } from '../src/config.js';

test('loads Yach IM config and keeps it disabled by default', () => {
  const disabled = loadRuntimeConfig({});
  assert.equal(disabled.yachEnabled, false);
  assert.equal(disabled.yachAppKey, '');
  assert.equal(disabled.yachCliPath, 'yach-cli');
  assert.equal(isYachImConfigured(disabled), false);

  const enabled = loadRuntimeConfig({
    HARMONY_AGENT_YACH_ENABLED: 'true',
    HARMONY_AGENT_YACH_APP_KEY: 'key-from-harmony',
    HARMONY_AGENT_YACH_APP_SECRET: 'secret',
    HARMONY_AGENT_YACH_CLI_PATH: '/usr/local/bin/yach-cli',
    YACH_APP_KEY: 'ignored-when-harmony-set',
  });
  assert.equal(enabled.yachEnabled, true);
  assert.equal(enabled.yachAppKey, 'key-from-harmony');
  assert.equal(enabled.yachAppSecret, 'secret');
  assert.equal(enabled.yachCliPath, '/usr/local/bin/yach-cli');
  assert.equal(isYachImConfigured(enabled), true);
});

test('maps tool names to medium progress labels', () => {
  assert.equal(progressLabelForTool('search_knowledge'), '正在查阅知识库');
  assert.equal(progressLabelForTool('repository_read_file'), '正在读取代码证据');
  assert.equal(progressLabelForTool('lookup_learner'), '正在查询学员信息');
  assert.equal(progressLabelForTool('other_tool'), '正在收集证据');
});

test('parses private CLI event frames including nested data strings', () => {
  const event = parseYachEvent({
    data: JSON.stringify({
      msgtype: 'text',
      conversationType: '1',
      createAt: Date.now(),
      senderUUid: 'yach167680',
      msgId: 'msg-1',
      conversationId: 'conv-1',
      userJson: { workCode: '080230', name: 'Tester' },
      content: '启动页白屏',
    }),
  });
  assert.equal(event.workCode, '080230');
  assert.equal(event.text, '启动页白屏');
  assert.equal(event.conversationType, '1');
  assert.equal(event.toId, 'yach167680');
  assert.equal(event.groupId, null);
});

test('parses group @ events', () => {
  const event = parseYachEvent({
    msgtype: 'text',
    conversationType: '2',
    createAt: Date.now(),
    senderUUid: 'yach167680',
    msgId: 'msg-2',
    conversationId: '64134877732',
    userJson: { workCode: '080230', name: 'Tester' },
    content: '@诊断助手 帮我看下报错',
  });
  assert.equal(event.conversationType, '2');
  assert.equal(event.groupId, '64134877732');
  assert.equal(event.toId, '64134877732');
});

test('accepts letter-prefixed work codes from group events', () => {
  const event = parseYachEvent({
    msgtype: 'text',
    conversationType: '2',
    createAt: Date.now(),
    senderUUid: 'yach999',
    msgId: 'msg-v',
    conversationId: '64134877732',
    userJson: { workCode: 'V0047863', name: 'Vendor' },
    content: '@助手 你好',
  });
  assert.equal(event.workCode, 'V0047863');
  assert.equal(event.conversationType, '2');
});

test('fold 快捷回复消息按文本解析（归档回执通道）', () => {
  // 真实形态：content 是链接本体，回执文本在 reply 参数（URL 编码）。
  const event = parseYachEvent({
    msgtype: 'fold',
    conversationType: '2',
    createAt: Date.now(),
    senderUUid: 'yach999',
    msgId: 'msg-fold',
    conversationId: '64134877732',
    userJson: { workCode: 'V0047863', name: 'Tester' },
    content: `yach://yach.zhiyinlou.com/session/robot?type=fold&extra=%7B%7D&reply=${encodeURIComponent('问题分析正确')}`,
  });
  assert.equal(event.text, '问题分析正确');
  assert.equal(event.workCode, 'V0047863');

  // 非链接形态的 fold（理论上）保留原文。
  const plain = parseYachEvent({
    msgtype: 'fold',
    conversationType: '2',
    createAt: Date.now(),
    senderUUid: 'yach999',
    msgId: 'msg-fold-2',
    conversationId: '64134877732',
    userJson: { workCode: 'V0047863', name: 'Tester' },
    content: '问题分析失败',
  });
  assert.equal(plain.text, '问题分析失败');
});

test('ignores bot workCode -1', () => {
  assert.throws(() => parseYachEvent({
    msgtype: 'text',
    conversationType: '1',
    createAt: Date.now(),
    senderUUid: 'bot',
    msgId: 'msg-3',
    conversationId: 'c',
    userJson: { workCode: '-1' },
    content: 'stream',
  }), /bot message/);
});

test('summarizes group history for prompt injection', () => {
  const summary = summarizeGroupHistory([
    { senderName: '甲', content: '接口超时了' },
    { senderNick: '乙', text: '复现路径发一下' },
  ]);
  assert.match(summary, /甲: 接口超时了/);
  assert.match(summary, /乙: 复现路径发一下/);
  assert.match(
    buildGroupDiagnosisContent('帮我看', summary),
    /【当前提问】\n帮我看/,
  );
});

test('group history excludes the bot itself and error dumps', () => {
  const summary = summarizeGroupHistory([
    { senderName: '甲', content: '单曲循环会自己停' },
    { senderName: '培优问题排查助手', content: '判定：已定位\n【给支持老师】…' },
    { senderName: '机器人二号', text: '诊断失败：服务调用异常' },
    { senderName: '乙', content: '{"message":"Bad Request","name":"AI_APICallError","stack":"AI_APICallError\\n at (/app/x.ts)"}' },
    { senderName: '丙', content: '任务进度' },
    { senderName: '丁', content: '诊断进度' },
    { senderName: '戊', content: '- 正在查询远程日志（12 秒）' },
    { senderName: '乙', content: '7:00-7:40 之间复现' },
  ], { excludeSenders: ['培优问题排查助手', '机器人二号'] });
  assert.match(summary, /甲: 单曲循环会自己停/);
  assert.match(summary, /乙: 7:00-7:40 之间复现/);
  assert.doesNotMatch(summary, /培优问题排查助手|机器人二号|AI_APICallError|任务进度|诊断进度|正在查询远程日志|判定：/);
});

test('group history filters session control commands from users', () => {
  const summary = summarizeGroupHistory([
    { senderName: '甲', content: '/new' },
    { senderName: '乙', content: '/stop' },
    { senderName: '丙', content: '支付页面打不开' },
  ]);
  assert.equal(summary, '丙: 支付页面打不开');
});

test('groupHistory floor overrides the 30-minute window (session boundary from /new)', async () => {
  const calls: string[][] = [];
  const cli = new YachCli({
    cliPath: 'yach-cli',
    appKey: 'k',
    appSecret: 's',
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === 'config') return { stdout: '{"ok":true}', stderr: '', code: 0 };
      return {
        stdout: JSON.stringify({ ok: true, data: { code: 200, msg: '', obj: { messages: [] } } }),
        stderr: '',
        code: 0,
      };
    },
  });
  const floor = Math.floor(Date.now() / 1000) - 60; // 1 分钟前，远高于 30 分钟窗口起点
  await cli.groupHistory('g1', 30, floor);
  const historyCall = calls.find((args) => args[0] === 'im' && args[1] === 'history')!;
  const start = Number(historyCall[historyCall.indexOf('--start-time') + 1]);
  assert.equal(start, floor);
  // 不传 floor 时维持 30 分钟窗口
  await cli.groupHistory('g1');
  const plainCall = calls.filter((args) => args[0] === 'im' && args[1] === 'history')[1]!;
  const plainStart = Number(plainCall[plainCall.indexOf('--start-time') + 1]);
  assert.ok(plainStart <= Math.floor(Date.now() / 1000) - 29 * 60);
});

test('extractList unwraps yach-cli data.obj.messages envelope', () => {
  const rows = extractList({
    ok: true,
    data: {
      code: 200,
      msg: '',
      obj: {
        messages: [{ content: 'hi', senderName: 'A' }],
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(extractList({
    ok: true,
    data: { code: 200, msg: '', obj: [{ group_tid: '1' }] },
  }), [{ group_tid: '1' }]);
  assert.throws(() => extractList({
    ok: true,
    data: { code: 10030, msg: 'page_size bad', obj: null },
  }), /page_size/);
});

test('parseCliJson reads last JSON object line', () => {
  const payload = parseCliJson('noise\n{"ok":true,"data":{"group_id":"1"}}\n');
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { group_id: '1' });
});

test('YachCli sendMarkdown and history use injected runner', async () => {
  const calls: string[][] = [];
  const cli = new YachCli({
    cliPath: 'yach-cli',
    appKey: 'k',
    appSecret: 's',
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === 'config') return { stdout: '{"ok":true}', stderr: '', code: 0 };
      if (args[0] === 'im' && args[1] === 'send') {
        return { stdout: '{"ok":true,"data":{}}', stderr: '', code: 0 };
      }
      if (args[0] === 'im' && args[1] === 'history') {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              code: 200,
              msg: '',
              obj: { messages: [{ content: 'hi', senderName: 'A' }] },
            },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '{"ok":false}', stderr: '', code: 1 };
    },
  });

  await cli.sendMarkdown({ toId: 'yach1', conversationType: '1' }, 'hello');
  const history = await cli.groupHistory('64134877732');
  assert.equal(history.length, 1);
  assert.ok(calls.some((args) => args[0] === 'config' && args[1] === 'init'));
  assert.ok(calls.some((args) => args.includes('--markdown') && args.includes('hello')));
  assert.ok(calls.some((args) => args.includes('--group-id') && args.includes('64134877732')));
  assert.ok(calls.some((args) => args.includes('--start-time') && args.includes('--end-time')));
  assert.ok(IM_MESSAGE_LIMIT > 0);

  const cardCli = new YachCli({
    cliPath: 'yach-cli',
    appKey: 'k',
    appSecret: 's',
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === 'config') return { stdout: '{"ok":true}', stderr: '', code: 0 };
      if (args[0] === 'api' && args[2] === '/openapi/v2/msg_card/create') {
        return { stdout: '{"ok":true,"data":{"code":200,"obj":{"msg_id":"card-9"}}}', stderr: '', code: 0 };
      }
      if (args[0] === 'api' && args[2] === '/openapi/v2/msg_content/push') {
        return { stdout: '{"ok":true,"data":{"code":200,"obj":{}}}', stderr: '', code: 0 };
      }
      if (args[0] === 'api' && args[2] === '/openapi/v2/msg_card/close') {
        return { stdout: '{"ok":true,"data":{"code":200,"obj":{}}}', stderr: '', code: 0 };
      }
      return { stdout: '{"ok":false}', stderr: '', code: 1 };
    },
  });
  const cardId = await cardCli.createCard({ toId: 'user-1', conversationType: '1' });
  assert.equal(cardId, 'card-9');
  await cardCli.pushCard(cardId, 'hello card');
  await cardCli.closeCard(cardId);
  assert.ok(calls.some((args) => args[0] === 'api' && args.includes('/openapi/v2/msg_card/create')));

  await assert.rejects(
    () => new YachCli({
      cliPath: 'yach-cli',
      appKey: 'k',
      appSecret: 's',
      runCommand: async () => ({ stdout: '{"ok":false,"error":{"message":"x"}}', stderr: '', code: 1 }),
    }).sendMarkdown({ toId: 'u', conversationType: '1' }, 'x'),
    (error: unknown) => error instanceof YachCliError,
  );
});
