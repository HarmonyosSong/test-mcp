import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { MCPClient } from '@mastra/mcp';

import { loadRuntimeConfig } from '../config.js';
import { createRuntimeDatabase } from '../migration/legacy.js';
import { ProductStore } from '../product/store.js';

type CaseFile = Record<string, any>;

function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  return mkdir(dirname(path), { recursive: true })
    .then(() => writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }))
    .then(() => rename(temporary, path));
}

async function readCase(path: string): Promise<CaseFile> {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.message) throw new Error('invalid diagnosis case file');
  return value;
}

function casePath(path: string, directory: string): string {
  const resolved = resolve(directory, path);
  const relativePath = relative(resolve(directory), resolved);
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes('/')) throw new Error('case must be a JSON file directly inside the case directory');
  return resolved;
}

async function knowledgeSearch(config: ReturnType<typeof loadRuntimeConfig>, query: string): Promise<string[]> {
  const client = new MCPClient({
    id: `mastra-case-search-${Date.now()}`,
    registerProcessHooks: false,
    servers: {
      knowledge: {
        command: config.mcpCommand,
        args: ['run', '--project', resolve(config.projectRoot, 'mcp_server'), 'harmony-knowledge-mcp'],
        cwd: config.projectRoot,
        stderr: 'pipe',
        env: { HARMONY_AGENT_KNOWLEDGE_ROOT: resolve(config.projectRoot, config.knowledgeRoot) },
      },
    },
  });
  try {
    const tools = await client.listToolsets();
    const search = (tools.knowledge as Record<string, { execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown> }> | undefined)?.search_knowledge;
    if (!search?.execute) return [];
    const result: any = await search.execute({ query, scope: 'all', limit: 5 }, {});
    const outer = result?.result ?? result;
    const matches = outer?.matches ?? outer?.results ?? [];
    return Array.isArray(matches) ? matches.flatMap((item) => typeof item?.name === 'string' ? [item.name] : []) : [];
  } finally {
    await client.disconnect();
  }
}

function locateEntry(root: string, name: string): string | null {
  const base = resolve(root);
  const facts = resolve(base, 'facts');
  const symptoms = resolve(base, 'symptoms');
  const candidates = [resolve(symptoms, `${name}.md`)];
  // Business domains are directory names; recursively enumerate only two levels.
  for (const domain of readdirSyncSafe(facts)) candidates.push(resolve(facts, domain, `${name}.md`));
  const found = candidates.filter((path) => existsSyncSafe(path));
  if (found.length > 1) throw new Error(`duplicate knowledge ID: ${name}`);
  return found[0] ?? null;
}

function readdirSyncSafe(path: string): string[] {
  try { return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory()); }
  catch { return []; }
}

function existsSyncSafe(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

async function validateKnowledge(config: ReturnType<typeof loadRuntimeConfig>, root: string): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    let output = '';
    let errors = '';
    const child = spawn(config.mcpCommand, ['run', '--project', resolve(config.projectRoot, 'mcp_server'), 'harmony-knowledge-validate', root], { cwd: config.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`knowledge validation failed (${code ?? 'signal'}) at ${root}: ${errors || output}`));
      const match = output.match(/现象未覆盖事实：(\d+)/);
      if (!match) return reject(new Error('knowledge validator did not report orphan-fact count'));
      resolvePromise(Number(match[1]));
    });
  });
}

export async function listCases(directory: string): Promise<Array<{ id: string; outcome: string; knowledge_entry: string }>> {
  await mkdir(directory, { recursive: true });
  const rows = [];
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.json')).sort()) {
    const value = await readCase(join(directory, name));
    rows.push({ id: value.id, outcome: value.review?.outcome ?? 'pending', knowledge_entry: value.knowledge_entry ?? '未提炼' });
  }
  return rows;
}

export async function captureCase(config: ReturnType<typeof loadRuntimeConfig>, conversationId: string, messageId: string, directory: string): Promise<string> {
  const database = createRuntimeDatabase(config);
  const store = new ProductStore(database);
  try {
    const conversation = await store.getConversation(conversationId);
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message || message.role !== 'assistant' || message.status === 'streaming') throw new Error('只能归档已结束的 assistant 轮次');
    const path = join(directory, `${conversation.id}-${message.id}.json`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify({ id: `${conversation.id}-${message.id}`, conversation_id: conversation.id, message_id: message.id, captured_at: new Date().toISOString(), input: conversation.messages[conversation.messages.indexOf(message) - 1]?.content ?? '', repository_id: conversation.repository_id, commit: conversation.resolved_commit, message, evidence_state: conversation.evidence_state, review: null, knowledge_entry: null }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return path;
  } finally {
    await store.close();
  }
}

export async function reviewCase(path: string, input: { outcome: string; rootCause: string; reviewer: string; evidenceIds: string[] }): Promise<void> {
  if (!['confirmed', 'rejected', 'uncertain'].includes(input.outcome)) throw new Error('invalid outcome');
  if (!input.reviewer.trim() || !input.rootCause.trim()) throw new Error('必须填写复核人和结论理由');
  const value = await readCase(path);
  const observed = new Set((value.message.report?.evidence ?? []).filter((item: any) => ['source', 'log'].includes(item.kind)).map((item: any) => item.id));
  if (input.evidenceIds.some((id) => !observed.has(id))) throw new Error('证据 ID 必须来自已校验报告的源码或日志观测');
  if (input.outcome === 'confirmed' && !input.evidenceIds.length) throw new Error('确认根因必须关联实际观测证据');
  value.review = { outcome: input.outcome, root_cause: input.rootCause, reviewer: input.reviewer, evidence_ids: input.evidenceIds, reviewed_at: new Date().toISOString() };
  await atomicJson(path, value);
}

export async function draftCase(path: string, config: ReturnType<typeof loadRuntimeConfig>, name: string, domain: string): Promise<string> {
  if (![name, domain].every((value) => /^[a-z0-9][a-z0-9-]*$/.test(value))) throw new Error('name/domain 必须为 kebab-case');
  const value = await readCase(path);
  if (value.review?.outcome !== 'confirmed') throw new Error('先复核并确认根因，再提炼知识');
  const root = config.knowledgeRoot;
  const existing = locateEntry(root, name);
  if (existing && !existing.startsWith(`${resolve(root, 'facts')}/`)) throw new Error('不能用事实草稿覆盖现象 ID');
  const candidates = await knowledgeSearch(config, value.input ?? '');
  let body: string;
  if (existing) {
    body = await readFile(existing, 'utf8');
  } else {
    const metadata = [
      `name: ${name}`, 'kind: mapping', `domains: [${domain}]`, 'applies_to: [harmony]', 'authority: auto',
      `updated_at: ${new Date().toISOString().slice(0, 10)}`, 'description: "待提炼：填写可复用的现象与判据"', 'aliases: []',
    ].join('\n');
    body = `---\n${metadata}\n---\n\n# 待提炼\n\n## 事实与适用范围\n\n待提炼\n\n## 判据\n\n待提炼\n\n## 例外\n\n待提炼\n`;
  }
  const draft = path.replace(/\.json$/i, '.md');
  try { await writeFile(draft, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('草稿已存在，保留人工编辑，请直接编辑现有草稿'); throw error; }
  value.proposal = { name, domain, draft, existing_entry: existing ? name : null, base_sha256: existing ? createHash('sha256').update(await readFile(existing)).digest('hex') : null, similar_entries: candidates };
  await atomicJson(path, value);
  return draft;
}

export async function applyDraft(path: string, config: ReturnType<typeof loadRuntimeConfig>): Promise<string> {
  const value = await readCase(path);
  if (value.review?.outcome !== 'confirmed' || !value.proposal) throw new Error('先确认案例并生成知识草稿');
  const proposal = value.proposal;
  if (![proposal.name, proposal.domain].every((item: unknown) => typeof item === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(item))) throw new Error('invalid saved proposal identity');
  const draft = resolve(proposal.draft);
  if (draft !== resolve(path.replace(/\.json$/i, '.md'))) throw new Error('proposal draft path must be beside its case file');
  const root = resolve(config.knowledgeRoot);
  const body = await readFile(draft, 'utf8');
  if (body.includes('待提炼')) throw new Error('请完成草稿中的待提炼内容和适用范围');
  const existing = locateEntry(root, proposal.name);
  let target: string;
  if (existing) {
    if (!proposal.base_sha256 || createHash('sha256').update(await readFile(existing)).digest('hex') !== proposal.base_sha256) throw new Error('规范条目已变化，请合并新内容后重新生成草稿');
    target = existing;
  } else {
    if (proposal.existing_entry) throw new Error('提案的规范条目已经消失，请重新生成草稿');
    target = resolve(root, 'facts', proposal.domain, `${proposal.name}.md`);
  }
  const temporaryRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'mastra-knowledge-')));
  try {
    const stagedRoot = join(temporaryRoot, 'knowledge');
    await import('node:fs/promises').then(({ cp }) => cp(root, stagedRoot, { recursive: true }));
    const targetRelative = relative(root, target);
    if (!targetRelative.startsWith(`facts${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('knowledge proposal target must stay under facts/<domain>');
    const stagedTarget = join(stagedRoot, targetRelative);
    await mkdir(dirname(stagedTarget), { recursive: true });
    await writeFile(stagedTarget, body, 'utf8');
    const stagedOrphans = await validateKnowledge(config, stagedRoot);
    if (stagedOrphans > 0) throw new Error('存在未关联到症状入口的事实；请先在 knowledge/symptoms 中补充对应 [[name]] 和区分问题');
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await copyFile(stagedTarget, temporary);
    await rename(temporary, target);
    value.knowledge_entry = proposal.name;
    value.linked_at = new Date().toISOString();
    await atomicJson(path, value);
    return target;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function linkCase(path: string, config: ReturnType<typeof loadRuntimeConfig>, name: string): Promise<void> {
  const value = await readCase(path);
  if (value.review?.outcome !== 'confirmed') throw new Error('只有确认案例可标记已提炼');
  const entry = locateEntry(config.knowledgeRoot, name);
  if (!entry || !entry.startsWith(`${resolve(config.knowledgeRoot, 'facts')}/`)) throw new Error('须关联已入库的规范事实 ID');
  value.knowledge_entry = name;
  value.linked_at = new Date().toISOString();
  await atomicJson(path, value);
}

export function resolveCasePath(path: string, directory: string): string { return casePath(path, directory); }
