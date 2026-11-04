import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compare, isProviderQuotaExhausted, parseDataset, runLive, summarize } from '../src/evaluation/live.js';

test('dataset validation retains ordered multi-turn cases and rejects malformed rows', () => {
  const rows = parseDataset('{"id":"case-a","prompts":["one","two"],"expected":[{},{}]}\n');
  assert.equal(rows[0].prompts.length, 2);
  assert.throws(() => parseDataset('{broken'), /line 1/);
  assert.throws(() => parseDataset('{"id":"same","prompts":["x"],"expected":[{}]}\n{"id":"same","prompts":["y"],"expected":[{}]}'), /duplicate id/);
  assert.throws(() => parseDataset('{"id":"case-a","prompts":["one","two"],"expected":[{}]}'), /one expected record/);
  assert.throws(() => parseDataset('{"id":"case-a","files":{"../../escape":"x"},"prompts":["one"],"expected":[{}]}'), /unsafe fixture path/);
  assert.throws(() => parseDataset('{"id":"case-a","prompts":["one"],"expected":[{"verdict":"unknown"}]}'), /invalid verdict assertion/);
});

test('supplemental migration quality dataset retains the legacy scenarios and extends source coverage', async () => {
  const raw = await readFile(new URL('../src/evaluation/datasets/migration-quality.jsonl', import.meta.url), 'utf8');
  const cases = parseDataset(raw);
  assert.deepEqual(cases.map((item) => item.id), [
    'source-report',
    'insufficient-report',
    'business-clarification',
    'legacy-login-insufficient',
    'legacy-login-source',
    'missing-source-insufficient',
  ]);
  assert.equal(cases.reduce((turns, item) => turns + item.prompts.length, 0), 7);
  assert.equal(cases[2]?.prompts.length, 2);
});

test('summary keeps failures, unknown quality, and incomplete cost as unknown', () => {
  const summary = summarize([
    { case_id: 'a:0', status: 'completed', input_tokens: 10, model_requests: 2, correct_location: true, unsupported_conclusion: null },
    { case_id: 'b:0', status: 'failed', input_tokens: null, correct_location: false },
  ]);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.correct_location, { assessed: 2, unassessed: 0, rate: 0.5 });
  assert.deepEqual(summary.unsupported_conclusion, { assessed: 0, unassessed: 2, rate: null });
  assert.deepEqual((summary.cost as any).input_tokens, { known_total: 10, unknown_turns: 1, total: null });
  assert.deepEqual((summary.cost as any).model_requests, { known_total: 2, unknown_turns: 1, total: null });
});

test('live evaluation identifies a provider quota exhaustion and leaves unrelated failures alone', () => {
  assert.equal(isProviderQuotaExhausted("You've reached your 5-hour usage limit. Your quota will reset later."), true);
  assert.equal(isProviderQuotaExhausted('HTTP 429: too many requests'), false);
  assert.equal(isProviderQuotaExhausted('Invalid API key'), false);
});

test('live evaluation stops after a provider quota response and records an incomplete artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-eval-quota-'));
  const dataset = join(directory, 'dataset.jsonl');
  const output = join(directory, 'result.json');
  const config = join(directory, 'model-config.json');
  const original = {
    mode: process.env.HARMONY_AGENT_MODE,
    modelConfig: process.env.HARMONY_AGENT_MODEL_CONFIG_FILE,
  };
  let requests = 0;
  const quotaMessage = "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: quotaMessage } }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    await writeFile(dataset, `${JSON.stringify({ id: 'quota-case', prompts: ['one', 'two', 'three'], expected: [{}, {}, {}] })}\n`);
    await writeFile(config, JSON.stringify({
      provider: 'openai',
      model_name: 'test-model',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: 'local-test-key',
      compatibility_mode: 'standard',
    }));
    process.env.HARMONY_AGENT_MODE = 'demo';
    process.env.HARMONY_AGENT_MODEL_CONFIG_FILE = config;

    const artifact = await runLive(dataset, output);
    assert.equal(requests, 1);
    assert.equal(artifact.complete, false);
    assert.equal(artifact.expected_turns, 3);
    assert.equal(artifact.stop_reason, 'provider_quota_exhausted');
    assert.equal(artifact.rows.length, 1);
    assert.equal(artifact.rows[0].status, 'failed');
  } finally {
    if (original.mode === undefined) delete process.env.HARMONY_AGENT_MODE;
    else process.env.HARMONY_AGENT_MODE = original.mode;
    if (original.modelConfig === undefined) delete process.env.HARMONY_AGENT_MODEL_CONFIG_FILE;
    else process.env.HARMONY_AGENT_MODEL_CONFIG_FILE = original.modelConfig;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('baseline requires matching model, dataset and ordered rows, and leaves unknown deltas null', () => {
  const summary = summarize([{ case_id: 'a:0', status: 'completed', input_tokens: 10 }]);
  const run = { model: { provider: 'test' }, dataset_sha256: 'same', rows: [{ case_id: 'a:0', status: 'completed', input_tokens: 10 }], summary };
  assert.equal(compare(run, run).cost_delta.input_tokens, 0);
  assert.equal(compare({ ...run, rows: [{ case_id: 'a:0', status: 'completed', input_tokens: null }] , summary: summarize([{ case_id: 'a:0', status: 'completed', input_tokens: null }]) }, run).cost_delta.input_tokens, null);
  assert.throws(() => compare({ ...run, model: 'different' }, run), /model/);
  assert.throws(() => compare({ ...run, rows: [] }, run), /ordered cases/);
});

test('live evaluation validates cases and fixture containment before requiring a configured provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-eval-test-'));
  const dataset = join(directory, 'dataset.jsonl');
  const output = join(directory, 'out', 'latest.json');
  const originalMode = process.env.HARMONY_AGENT_MODE;
  const originalConfig = process.env.HARMONY_AGENT_MODEL_CONFIG_FILE;
  try {
    await writeFile(dataset, '{"id":"case-a","files":{"../../escape.ets":"x"},"prompts":["x"],"expected":[{}]}\n');
    await assert.rejects(runLive(dataset, output), /fixture path escapes/);
    await writeFile(dataset, '{"id":"case-a","prompts":["x"],"expected":[{}]}\n');
    process.env.HARMONY_AGENT_MODE = 'demo';
    process.env.HARMONY_AGENT_MODEL_CONFIG_FILE = join(directory, 'missing-model-config.json');
    await assert.rejects(runLive(dataset, output), /no configured model/);
    await assert.rejects(readFile(output), /./);
  } finally {
    if (originalMode === undefined) delete process.env.HARMONY_AGENT_MODE;
    else process.env.HARMONY_AGENT_MODE = originalMode;
    if (originalConfig === undefined) delete process.env.HARMONY_AGENT_MODEL_CONFIG_FILE;
    else process.env.HARMONY_AGENT_MODEL_CONFIG_FILE = originalConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test('live evaluation closes partially initialized runtime and removes scratch data on startup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-eval-startup-failure-'));
  const dataset = join(directory, 'dataset.jsonl');
  const invalidSkillsFile = join(directory, 'skills-file');
  const originalSkills = process.env.HARMONY_MASTRA_SKILLS_DIR;
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('harmony-mastra-eval-')));
  try {
    await writeFile(dataset, '{"id":"case-a","prompts":["x"],"expected":[{}]}\n');
    await writeFile(invalidSkillsFile, 'not a directory');
    process.env.HARMONY_MASTRA_SKILLS_DIR = invalidSkillsFile;
    await assert.rejects(runLive(dataset, join(directory, 'result.json')), /ENOTDIR|not a directory/i);
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('harmony-mastra-eval-'));
    assert.deepEqual(after.filter((name) => !before.has(name)), []);
  } finally {
    if (originalSkills === undefined) delete process.env.HARMONY_MASTRA_SKILLS_DIR;
    else process.env.HARMONY_MASTRA_SKILLS_DIR = originalSkills;
    await rm(directory, { recursive: true, force: true });
  }
});
