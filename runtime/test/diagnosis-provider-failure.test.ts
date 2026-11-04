import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTool } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { z } from 'zod';

import { DiagnosisAgent } from '../src/diagnosis/agent.js';
import { SkillRegistry } from '../src/diagnosis/skills.js';
import { ModelConfiguration } from '../src/model/configuration.js';

function chatChunk(id: string, choices: unknown[], usage?: Record<string, number>) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices, ...(usage ? { usage } : {}) })}\n\n`;
}

test('provider authentication failure becomes a failed diagnosis event without an unhandled rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-provider-failure-'));
  const skillsDir = join(directory, 'skills');
  await mkdir(skillsDir);
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":"unauthorized"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const configuration = new ModelConfiguration({ filePath: join(directory, 'model.json'), env: {} });
  await configuration.configure({
    provider: 'custom',
    model_name: 'test-model',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    no_api_key: true,
    compatibility_mode: 'relaxed',
  });
  const skills = new SkillRegistry(skillsDir);
  await skills.load();
  const diagnosis = new DiagnosisAgent(configuration, skills);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const events = [];
    for await (const event of diagnosis.stream({
      conversation: {
        id: 'provider-failure',
        messages: [],
        evidence_state: {},
      },
      content: 'test request',
    })) events.push(event);
    const finalEvent = events.at(-1);
    assert.equal(finalEvent?.type, 'failed');
    if (finalEvent?.type === 'failed') assert.equal(finalEvent.failure_category, 'provider_error');
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed provider tool JSON does not leave pending tool events or prevent a terminal response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-provider-malformed-tool-'));
  const skillsDir = join(directory, 'skills');
  await mkdir(skillsDir);
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (requestCount === 1) {
      response.write(chatChunk('malformed-tool', [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call-malformed', type: 'function', function: { name: 'submit_diagnosis_report', arguments: '{"verdict":' } }] },
        finish_reason: null,
      }]));
      response.write(chatChunk('malformed-tool', [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }));
    } else {
      response.write(chatChunk('malformed-recovery', [{ index: 0, delta: { content: '参数格式错误，当前没有可验证的报告。' }, finish_reason: null }]));
      response.write(chatChunk('malformed-recovery', [{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const configuration = new ModelConfiguration({ filePath: join(directory, 'model.json'), env: {} });
  await configuration.configure({
    provider: 'custom',
    model_name: 'test-model',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    no_api_key: true,
    compatibility_mode: 'relaxed',
  });
  const skills = new SkillRegistry(skillsDir);
  await skills.load();
  const diagnosis = new DiagnosisAgent(configuration, skills);

  try {
    const events = [];
    for await (const event of diagnosis.stream({
      conversation: { id: 'malformed-tool', messages: [], evidence_state: {} },
      content: '请检查这个问题',
    })) events.push(event);
    const toolEvents = events.filter((event) => event.type === 'tool-start' || event.type === 'tool-end');
    const starts = toolEvents.filter((event) => event.type === 'tool-start');
    const ends = toolEvents.filter((event) => event.type === 'tool-end');
    assert.equal(requestCount, 2);
    assert.equal(starts.length, ends.length);
    if (starts.length > 0) {
      assert.equal(starts.length, 1);
      assert.equal(ends[0]?.type === 'tool-end' && ends[0].event.status, 'failed');
      assert.equal(ends[0]?.type === 'tool-end' && ends[0].event.id, starts[0]?.type === 'tool-start' ? starts[0].event.id : null);
    }
    const finalEvent = events.at(-1);
    assert.equal(finalEvent?.type, 'completed');
    if (finalEvent?.type === 'completed') {
      assert.equal(Number(finalEvent.tool_usage.blocked), 1);
      assert.equal(Number(finalEvent.tool_usage.attempted), 1);
      assert.equal(Number(finalEvent.tool_usage.accepted), 0);
    }
    assert.equal(events.some((event) => event.type === 'failed'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('assembles fragmented tool arguments and closes emitted events when the provider stream drops', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-provider-fragmented-tool-'));
  const skillsDir = join(directory, 'skills');
  await mkdir(skillsDir);
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (requestCount === 1) {
      response.write(chatChunk('fragmented-tool', [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call-fragmented', type: 'function', function: { name: 'read_project_file', arguments: '{"relative_' } }] },
        finish_reason: null,
      }]));
      response.write(chatChunk('fragmented-tool', [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"Entry.ets"}' } }] },
        finish_reason: null,
      }]));
      response.end(chatChunk('fragmented-tool', [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + 'data: [DONE]\n\n');
      return;
    }
    response.write(chatChunk('fragmented-recovery', [{ index: 0, delta: { content: '已读取源码，' }, finish_reason: null }]), () => {
      setTimeout(() => response.destroy(), 10);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const configuration = new ModelConfiguration({ filePath: join(directory, 'model.json'), env: {} });
  await configuration.configure({
    provider: 'custom',
    model_name: 'test-model',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    no_api_key: true,
    compatibility_mode: 'relaxed',
  });
  const skills = new SkillRegistry(skillsDir);
  await skills.load();
  const diagnosis = new DiagnosisAgent(configuration, skills, new Mastra({ logger: false }));
  const observedArgs: Array<{ relative_path: string }> = [];
  const readFile = createTool({
    id: 'read_project_file',
    description: 'Read one file from the test workspace.',
    inputSchema: z.object({ relative_path: z.string() }),
    execute: async (args) => {
      observedArgs.push(args);
      return { path: args.relative_path, start_line: 1, end_line: 1, content: 'export const name = "test";' };
    },
  });

  try {
    const events = [];
    for await (const event of diagnosis.stream({
      conversation: { id: 'fragmented-tool-drop', messages: [], evidence_state: {} },
      content: '请读取 Entry.ets 并说明证据。',
      toolsets: { repository: { read_project_file: readFile } },
    })) events.push(event);
    const starts = events.filter((event) => event.type === 'tool-start');
    const ends = events.filter((event) => event.type === 'tool-end');
    const terminal = events.at(-1);
    assert.ok(requestCount > 1, 'provider stream should retry after the dropped connection');
    assert.deepEqual(observedArgs, [{ relative_path: 'Entry.ets' }]);
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0]?.type === 'tool-start' ? starts[0].event.id : null, ends[0]?.type === 'tool-end' ? ends[0].event.id : undefined);
    assert.equal(ends[0]?.type === 'tool-end' ? ends[0].event.status : null, 'completed');
    assert.ok(events.some((event) => event.type === 'text' && event.delta === '已读取源码，'));
    assert.equal(terminal?.type, 'failed');
    if (terminal?.type === 'failed') assert.equal(terminal.failure_category, 'provider_error');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
