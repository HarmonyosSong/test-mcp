import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRuntimeConfig } from '../src/config.js';
import { applyDraft, draftCase, linkCase, resolveCasePath, reviewCase } from '../src/evaluation/cases.js';

const sample = {
  id: 'case-sample',
  input: '页面进入后闪退',
  message: {
    role: 'assistant', status: 'completed', content: '已确认。',
    report: { evidence: [
      { id: 'source-1', kind: 'source', excerpt: 'name!.toUpperCase()', location: 'Entry.ets' },
      { id: 'knowledge-1', kind: 'tool', excerpt: 'a static lead' },
    ] },
  },
  review: null,
  knowledge_entry: null,
};

test('case path rejects directory traversal and nested case paths', () => {
  assert.throws(() => resolveCasePath('../outside.json', '/tmp/cases'), /directly inside/);
  assert.throws(() => resolveCasePath('nested/case.json', '/tmp/cases'), /directly inside/);
  assert.equal(resolveCasePath('case.json', '/tmp/cases'), '/tmp/cases/case.json');
});

test('review requires observed source/log evidence for confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-cases-review-'));
  try {
    const path = join(directory, 'case.json');
    await writeFile(path, JSON.stringify(sample));
    await assert.rejects(reviewCase(path, { outcome: 'confirmed', rootCause: 'confirmed', reviewer: 'reviewer', evidenceIds: ['knowledge-1'] }), /源码或日志观测/);
    await assert.rejects(reviewCase(path, { outcome: 'confirmed', rootCause: 'confirmed', reviewer: 'reviewer', evidenceIds: [] }), /必须关联实际观测证据/);
    await reviewCase(path, { outcome: 'confirmed', rootCause: 'source dereference', reviewer: 'reviewer', evidenceIds: ['source-1'] });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved.review.evidence_ids, ['source-1']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mastra case proposals preserve auto authority and only apply after full knowledge validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-cases-proposal-'));
  const projectRoot = loadRuntimeConfig().projectRoot;
  const knowledgeRoot = join(directory, 'knowledge');
  const config = { ...loadRuntimeConfig(), projectRoot, knowledgeRoot };
  try {
    await cp(join(projectRoot, 'knowledge'), knowledgeRoot, { recursive: true });
    const path = join(directory, 'case.json');
    await writeFile(path, JSON.stringify({ ...sample, review: { outcome: 'confirmed', root_cause: 'verified', evidence_ids: ['source-1'] } }));
    const draft = await draftCase(path, config, 'mastra-case-proposal', 'shared');
    const generated = await readFile(draft, 'utf8');
    assert.match(generated, /authority: auto/);
    await assert.rejects(applyDraft(path, config), /待提炼/);
    const content = generated
      .replaceAll('待提炼', 'reviewed case-derived mapping content')
      .replace('description: "reviewed case-derived mapping content：填写可复用的现象与判据"', 'description: "Reviewed reusable mapping"');
    await writeFile(draft, content);
    const symptomPath = join(knowledgeRoot, 'symptoms', 'app-entry-content-missing.md');
    const originalSymptom = await readFile(symptomPath, 'utf8');
    await writeFile(symptomPath, `${originalSymptom}\n\n## Case proposal regression\n\n- 关联新事实：[[mastra-case-proposal]]。\n`);
    const target = await applyDraft(path, config);
    assert.equal(target, join(knowledgeRoot, 'facts', 'shared', 'mastra-case-proposal.md'));
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.knowledge_entry, 'mastra-case-proposal');
    await linkCase(path, config, 'mastra-case-proposal');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
