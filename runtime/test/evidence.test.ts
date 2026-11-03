import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceLedger, EvidenceLedgerError } from '../src/diagnosis/evidence.js';

function read(ledger: EvidenceLedger, path: string, content: string) {
  return ledger.capture('read_project_file', { relative_path: path }, {
    path,
    start_line: 1,
    content,
  }) as { evidence_refs: Array<{ id: string; kind: string; source: string; location: string }>; result: unknown };
}

function draft(id: string, excerpt: string, overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'probable',
    summary: 'A candidate cause',
    issue_category: 'runtime',
    confidence: 0.7,
    root_cause_candidates: [{
      title: 'Unsafe branch',
      explanation: 'The observed branch throws.',
      confidence: 0.7,
      evidence_ids: [id],
    }],
    evidence: [{ id, excerpt, supports: 'Observed throw site' }],
    ...overrides,
  };
}

test('captures only delivered source observations with deterministic stable IDs', () => {
  const ledger = new EvidenceLedger();
  const result = { path: 'src/a.ets', start_line: 8, content: 'throw new Error("boom")' };
  const first = ledger.capture('read_project_file', { relative_path: 'src/a.ets' }, result) as {
    evidence_refs: Array<{ id: string }>;
    result: unknown;
  };
  const second = ledger.capture('read_project_file', { relative_path: 'src/a.ets' }, result) as {
    evidence_refs: Array<{ id: string }>;
  };

  assert.equal(first.evidence_refs[0]?.id, second.evidence_refs[0]?.id);
  assert.deepEqual(first.result, result);
  assert.equal(ledger.entries.get(first.evidence_refs[0]!.id)?.location, 'src/a.ets:8');
  assert.deepEqual(ledger.capture('get_knowledge_entry', {}, { body: 'not observed' }), { body: 'not observed' });
  assert.equal(ledger.entries.size, 1);
});

test('search evidence contains only delivered matches, never locator metadata', () => {
  const ledger = new EvidenceLedger();
  const page = {
    matches: [{ path: 'a.ets', line: 10, excerpt: 'onShowFileSelector(callback)' }],
    locator_hint: 'The index claims another location.',
    next_cursor: null,
  };
  const captured = ledger.capture('search_project_text', { query: 'onShowFileSelector' }, page) as {
    evidence_refs: unknown[];
    result: typeof page;
  };
  assert.deepEqual(captured.result, page);
  assert.equal(captured.evidence_refs.length, 1);
  assert.equal([...ledger.entries.values()][0]?.excerpt, 'onShowFileSelector(callback)');
});

test('unprovided parser input cannot be promoted to log evidence', () => {
  const ledger = new EvidenceLedger({ inputTexts: ['Only a general report'] });
  const parsed = ledger.capture('parse_hilog', { log_text: 'invented Error' }, {
    error_lines: [{ line: 1, excerpt: 'invented Error' }],
  }) as { evidence_refs: unknown[]; limitation: string };
  assert.deepEqual(parsed.evidence_refs, []);
  assert.match(parsed.limitation, /不能作为/);
  assert.equal(ledger.entries.size, 0);
});

test('pasted logs require exact user-provided log text and retain line provenance', () => {
  const log = 'Info started\nError actual failure';
  const ledger = new EvidenceLedger({ inputTexts: [`Please inspect this log:\n${log}`] });
  const captured = ledger.capture('parse_hilog', { log_text: log }, {
    error_lines: [{ line: 2, excerpt: 'Error actual failure' }],
  }) as { evidence_refs: Array<{ kind: string; location: string }> };
  assert.equal(captured.evidence_refs[0]?.kind, 'log');
  assert.equal(captured.evidence_refs[0]?.location, 'pasted-hilog:2');
});

test('current-turn evidence survives the soft cap and protection resets after restore', () => {
  const ledger = new EvidenceLedger({ maxEntries: 1 });
  read(ledger, 'a.ets', 'old');
  read(ledger, 'b.ets', 'current');
  assert.equal(ledger.entries.size, 2);
  assert.deepEqual([...ledger.entries.values()].map((entry) => entry.location), ['a.ets:1', 'b.ets:1']);

  const restored = EvidenceLedger.restore(ledger.snapshot());
  read(restored, 'c.ets', 'next turn');
  assert.equal(restored.entries.size, 1);
  assert.equal([...restored.entries.values()][0]?.location, 'c.ets:1');
  assert.equal(restored.evicted.size, 2);
});

test('hard current-turn limits reject admission without returning a citation ID', () => {
  const ledger = new EvidenceLedger({ maxCurrentTurn: 1 });
  const first = read(ledger, 'a.ets', 'first');
  const second = read(ledger, 'b.ets', 'second') as {
    evidence_refs: unknown[];
    observation_capacity_reached?: boolean;
  };
  assert.equal(first.evidence_refs.length, 1);
  assert.equal(second.observation_capacity_reached, true);
  assert.deepEqual(second.evidence_refs, []);

  const byteBounded = new EvidenceLedger({ maxCurrentTurnBytes: 3 });
  const rejected = read(byteBounded, 'a.ets', 'four') as { evidence_refs: unknown[]; observation_capacity_reached?: boolean };
  assert.equal(rejected.observation_capacity_reached, true);
  assert.deepEqual(rejected.evidence_refs, []);
});

test('snapshot persists limits, observations, full text, and bounded tombstones', () => {
  const ledger = new EvidenceLedger({ maxEntries: 2, maxCurrentTurn: 7, maxCurrentTurnBytes: 1234 });
  read(ledger, 'a.ets', 'full source text');
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.ledger_version, 2);
  assert.equal(snapshot.max_entries, 2);
  assert.equal(snapshot.max_current_turn, 7);
  assert.equal(snapshot.max_current_turn_bytes, 1234);

  const restored = EvidenceLedger.restore({
    ...snapshot,
    entries: [...snapshot.entries, { malformed: true }],
    texts: { ...snapshot.texts, orphan: 'discard me' },
  });
  assert.equal(restored.maxEntries, 2);
  assert.equal(restored.maxCurrentTurn, 7);
  assert.equal(restored.texts.get([...restored.entries.keys()][0]!), 'full source text');
  assert.equal(restored.texts.has('orphan'), false);
});

test('expired and never-observed IDs produce distinct actionable errors', () => {
  const ledger = new EvidenceLedger({ maxEntries: 1 });
  const oldId = read(ledger, 'old.ets', 'old observation').evidence_refs[0]!.id;
  const nextTurn = EvidenceLedger.restore(ledger.snapshot());
  read(nextTurn, 'new.ets', 'new observation');

  assert.throws(
    () => nextTurn.resolveDraft(draft(oldId, 'old observation', {
      verdict: 'insufficient_evidence', root_cause_candidates: [],
    })),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'evidence_expired' && /old\.ets:1/.test(error.message),
  );
  assert.equal(nextTurn.expiredCount, 1);
  assert.throws(
    () => nextTurn.resolveDraft(draft('made-up-id', 'guess', {
      verdict: 'insufficient_evidence', root_cause_candidates: [],
    })),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'unknown_evidence_id' && /ev-/.test(error.message),
  );
});

test('rereading identical content restores its stable ID and clears the tombstone', () => {
  const ledger = new EvidenceLedger({ maxEntries: 1 });
  const originalId = read(ledger, 'a.ets', 'same').evidence_refs[0]!.id;
  const nextTurn = EvidenceLedger.restore(ledger.snapshot());
  read(nextTurn, 'b.ets', 'other');
  assert.equal(nextTurn.evicted.has(originalId), true);

  const reread = read(nextTurn, 'a.ets', 'same');
  assert.equal(reread.evidence_refs[0]?.id, originalId);
  assert.equal(nextTurn.entries.has(originalId), true);
  assert.equal(nextTurn.evicted.has(originalId), false);
  assert.equal(nextTurn.restoredCount, 1);
});

test('user references are stable and require verbatim excerpts', () => {
  const text = '用户报告点击完成后返回首页';
  const ledger = new EvidenceLedger({ inputTexts: [text] });
  const [reference] = ledger.registerUserTexts();
  assert.equal(reference?.id, ledger.registerUserTexts()[0]?.id);
  assert.equal(reference?.preview, text);
  assert.throws(
    () => ledger.resolveDraft(draft(reference!.id, '用户说应用崩溃')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'excerpt_mismatch',
  );
  const report = ledger.resolveDraft(draft(reference!.id, '点击完成后返回首页', {
    verdict: 'insufficient_evidence',
    root_cause_candidates: [],
  }));
  assert.equal(report.evidence[0]?.kind, 'user');
  assert.equal(report.evidence[0]?.source, 'user-message');
});

test('report citations are resolved from the ledger and excerpts must be literal', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', '1: throw Error("boom")').evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(id, 'throw Error("boom")'));
  assert.equal(report.evidence[0]?.kind, 'source');
  assert.equal(report.evidence[0]?.source, 'mcp:read_project_file');
  assert.equal(report.evidence[0]?.location, 'src/a.ets:1');
  assert.throws(
    () => ledger.resolveDraft(draft(id, 'fabricated excerpt')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'excerpt_mismatch',
  );
  assert.throws(() => ledger.resolveDraft(draft(id, 'throw Error("boom")', {
    evidence: [{ id, excerpt: 'throw Error("boom")', supports: 'x', source: 'forged' }],
  })));
});

test('positive candidates require source or log observations, never user-only evidence', () => {
  const ledger = new EvidenceLedger({ inputTexts: ['The app returns to the home screen'] });
  const userId = ledger.registerUserTexts()[0]!.id;
  assert.throws(
    () => ledger.resolveDraft(draft(userId, 'returns to the home screen')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'positive_without_observed_source',
  );

  const sourceId = read(ledger, 'src/a.ets', 'throw Error').evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(sourceId, 'throw Error'));
  assert.equal(report.verdict, 'probable');
});

test('same observation can support distinct excerpts but exact duplicate citations are rejected', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'line 1: throw Error').evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(id, 'throw Error', {
    evidence: [
      { id, excerpt: 'throw Error', supports: 'throw site' },
      { id, excerpt: 'line 1', supports: 'line position' },
    ],
  }));
  assert.equal(report.evidence.length, 2);
  assert.throws(() => ledger.resolveDraft(draft(id, 'throw Error', {
    evidence: [
      { id, excerpt: 'throw Error', supports: 'first' },
      { id, excerpt: 'throw Error', supports: 'duplicate' },
    ],
  })));
});
