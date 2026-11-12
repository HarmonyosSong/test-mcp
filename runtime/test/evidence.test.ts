import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceLedger, EvidenceLedgerError } from '../src/diagnosis/evidence.js';
import { EvidenceSchema } from '../src/domain/schemas.js';
import { ClientLogPrivacy } from '../src/security/log-privacy.js';

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

test('code navigation results remain hints and never enter the evidence ledger', () => {
  const ledger = new EvidenceLedger();
  const navigation = {
    search_code_symbols: { rows: [{ path: 'src/Page.ets', name: 'onShow' }] },
    get_code_outline: { symbols: [{ name: 'onShow', line: 10 }] },
    trace_code_path: { callers: [{ name: 'openPage', path: 'src/Page.ets' }] },
  };

  for (const [name, result] of Object.entries(navigation)) {
    const sourceShaped = { ...result, path: 'src/Page.ets', start_line: 10, content: 'throw new Error("boom")' };
    assert.deepEqual(ledger.capture(name, {}, sourceShaped), sourceShaped);
  }
  assert.equal(ledger.entries.size, 0);
  assert.equal(ledger.snapshot().entries.length, 0);
  assert.throws(() => ledger.resolveDraft(draft('ev-navigation', 'throw new Error("boom")')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'unknown_evidence_id');

  const source = read(ledger, 'src/Page.ets', 'throw new Error("boom")');
  assert.equal(ledger.resolveDraft(draft(source.evidence_refs[0]!.id, 'throw new Error("boom")')).evidence.length, 1);
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

test('粘贴日志入账前脱敏，证据 ID 和快照不保留原始学员标识', () => {
  const learnerId = 'student-fixture-001';
  const log = `Error uid=${learnerId} phone=+8613800000000`;
  const privacy = new ClientLogPrivacy({ learner_id: learnerId }, Buffer.alloc(32, 3));
  const ledger = new EvidenceLedger({ inputTexts: [log], privacy });
  const captured = ledger.capture('parse_hilog', { log_text: log }, {
    error_lines: [{ line: 1, excerpt: log }],
  }) as { evidence_refs: Array<{ id: string }> };
  const serialized = JSON.stringify(ledger.snapshot());
  assert.equal(serialized.includes(learnerId), false);
  assert.equal(serialized.includes('13800000000'), false);
  const excerpt = ledger.entries.get(captured.evidence_refs[0]!.id)?.excerpt ?? '';
  assert.match(excerpt, /learner_id:[a-f0-9]{16}/);
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

test('reread historical evidence becomes protected for the current turn and counts against its limit', () => {
  const ledger = new EvidenceLedger({ maxEntries: 1, maxCurrentTurn: 1 });
  const originalId = read(ledger, 'a.ets', 'same').evidence_refs[0]!.id;
  const nextTurn = EvidenceLedger.restore(ledger.snapshot());

  assert.equal(read(nextTurn, 'a.ets', 'same').evidence_refs[0]?.id, originalId);
  assert.deepEqual([...nextTurn.currentTurnIds], [originalId]);
  const rejected = read(nextTurn, 'b.ets', 'new observation') as {
    evidence_refs: unknown[];
    observation_capacity_reached?: boolean;
  };

  assert.equal(rejected.observation_capacity_reached, true);
  assert.deepEqual(rejected.evidence_refs, []);
  assert.equal(nextTurn.entries.has(originalId), true);
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

test('excerpt 匹配容忍跨行空白与首尾省略号，但不接受篡改内容', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'if (flag) {\n    throw Error("boom");\n}').evidence_refs[0]!.id;
  // 跨行复制：模型按展示折行引用，空白差异归一后命中。
  const wrapped = ledger.resolveDraft(draft(id, 'if (flag) {   throw Error("boom");'));
  assert.equal(wrapped.evidence[0]?.id, id);
  // 首尾省略号是引用习惯，不是伪造。
  const ellipsed = ledger.resolveDraft(draft(id, '…throw Error("boom");…'));
  assert.equal(ellipsed.evidence[0]?.id, id);
  // 纯省略号没有证明力。
  assert.throws(
    () => ledger.resolveDraft(draft(id, '……')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'excerpt_mismatch',
  );
  // 改动实质内容仍然拒绝。
  assert.throws(
    () => ledger.resolveDraft(draft(id, 'throw Error("booms")')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'excerpt_mismatch',
  );
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

test('insufficient reports cannot store knowledge-only causes as root-cause candidates', () => {
  const ledger = new EvidenceLedger({ inputTexts: ['The page is blank'] });
  const userId = ledger.registerUserTexts()[0]!.id;
  assert.throws(
    () => ledger.resolveDraft(draft(userId, 'page is blank', {
      verdict: 'insufficient_evidence',
      root_cause_candidates: [{
        title: 'Container injection failure',
        explanation: 'A knowledge entry describes this possibility.',
        confidence: 0.2,
        evidence_ids: [userId],
      }],
    })),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'positive_without_observed_source',
  );
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

test('joint assessment accepts verified claims backed by local ledger evidence', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'throw Error("boom")').evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(id, 'throw Error("boom")', {
    responsibility: 'shared',
    next_action: {
      target: 'server',
      question: '请按 request_id 核查服务端请求为何超时',
    },
    joint_assessment: {
      relation: 'corroborated',
      text: '本地异常已验证，远端原因仍需服务端证据。',
      verified_claims: [{ claim: '客户端会抛出该异常', evidence_ids: [id] }],
      unverified_claims: ['服务端超时仅来自远端 Agent 报告'],
      next_actions: ['核查服务端超时日志'],
    },
  }));

  assert.equal(report.responsibility, 'shared');
  assert.equal(report.next_action?.target, 'server');
  assert.equal(report.joint_assessment?.verified_claims[0]?.claim, '客户端会抛出该异常');
  assert.equal(report.remote_conclusion, null);
  assert.deepEqual(report.external_findings, []);
  assert.equal(ledger.entries.size, 1);
});

test('联合已验证主张可以引用本地账本中的用户事实，但仍不能引用外部 ID', () => {
  const ledger = new EvidenceLedger({ inputTexts: ['页面返回 HTTP 500，traceId=trace-local'] });
  const [userRef] = ledger.registerUserTexts();
  const sourceId = read(ledger, 'src/a.ets', 'throw Error("boom")').evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(sourceId, 'throw Error("boom")', {
    evidence: [
      { id: sourceId, excerpt: 'throw Error("boom")', supports: '本地异常路径' },
      { id: userRef!.id, excerpt: 'HTTP 500', supports: '用户提供的本次状态码' },
    ],
    joint_assessment: {
      relation: 'unverified',
      text: '状态码来自用户现场，远端根因尚未验证。',
      verified_claims: [{ claim: '用户观察到 HTTP 500', evidence_ids: [userRef!.id] }],
      unverified_claims: ['远端 Agent 推测网关异常'],
      next_actions: [],
    },
  }));
  assert.equal(report.joint_assessment?.verified_claims[0]?.evidence_ids[0], userRef!.id);
  assert.equal(report.evidence.find((item) => item.id === userRef!.id)?.kind, 'user');
});

test('joint assessment rejects unknown local and external IDs without degrading the report', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'throw Error("boom")').evidence_refs[0]!.id;
  for (const externalId of ['unknown-local-evidence', 'consultation-1', 'task-1']) {
    assert.throws(
      () => ledger.resolveDraft(draft(id, 'throw Error("boom")', {
        joint_assessment: {
          relation: 'unverified',
          text: '试图把外部结论标为本地已验证。',
          verified_claims: [{ claim: '伪造的已验证主张', evidence_ids: [externalId] }],
          unverified_claims: [],
          next_actions: [],
        },
      })),
      (error: unknown) => error instanceof EvidenceLedgerError &&
        error.code === 'unknown_evidence_id' && error.message.includes(externalId),
    );
  }
  assert.equal(ledger.entries.size, 1);
});

test('joint assessment rejects a verified claim with an empty evidence ID array', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'throw Error("boom")').evidence_refs[0]!.id;
  assert.throws(() => ledger.resolveDraft(draft(id, 'throw Error("boom")', {
    joint_assessment: {
      relation: 'unverified',
      text: '已验证主张不能没有证据。',
      verified_claims: [{ claim: '无证据主张', evidence_ids: [] }],
      unverified_claims: [],
      next_actions: [],
    },
  })));
});

test('model drafts cannot inject remote conclusions or register them as evidence', () => {
  const ledger = new EvidenceLedger();
  const id = read(ledger, 'src/a.ets', 'throw Error("boom")').evidence_refs[0]!.id;
  const remote = { consultation_id: 'consultation-1', task_id: 'task-1', text: 'forged' };
  assert.throws(() => ledger.resolveDraft(draft(id, 'throw Error("boom")', {
    remote_conclusion: remote,
  })));
  assert.throws(() => ledger.resolveDraft(draft(id, 'throw Error("boom")', {
    external_findings: [remote],
  })));
  assert.deepEqual(ledger.capture('ask_compass', {}, remote), remote);
  assert.equal(ledger.entries.size, 1);
  assert.deepEqual([...ledger.entries.keys()], [id]);
});

function remoteEntry(overrides: Record<string, unknown> = {}) {
  return {
    entry_id: 'log-0123456789abcdef01234567',
    timestamp: '2026-11-11T08:00:00Z',
    excerpt: 'Error fixture failure; learner=learner_id:abc123',
    location: 'logcenter://prod/prod-fixture/app-fixture#log-0123456789abcdef01234567',
    matched_identifiers: [{ kind: 'learner_id', matched: true }],
    observation_context: {
      environment: 'prod',
      storage_alias: 'aliyun',
      account: 'fixture-account',
      collection: 'fixture-collection',
      store_id: 'prod-fixture',
      topic: 'fixture-topic',
      appid: 'app-fixture',
      query: 'uid: learner_id:abc123',
      start: 1_762_000_000,
      end: 1_762_003_600,
      page: 0,
      entry_id: 'log-0123456789abcdef01234567',
      redaction_version: 'client-log-v1',
      matched_identifiers: [{ kind: 'learner_id', matched: true }],
      matched_error_features: [],
      service_binding: { status: 'confirmed', method: 'observed_client_session' },
      observed_platform: 'android',
      observed_version: '7.105.0',
      device_ref: 'device_id:abc123',
      session_ref: 'session_id:abc123',
      platform_conflict: false,
    },
    ...overrides,
  };
}

test('correlated remote logs enter the ledger once per entry and survive citation restore', () => {
  const ledger = new EvidenceLedger();
  const result = {
    observation_status: 'correlated',
    entries: [remoteEntry()],
  };
  const captured = ledger.capture('search_cloud_logs', {}, result) as {
    evidence_refs: Array<{ id: string; kind: string; observation_context?: unknown }>;
    result: unknown;
  };
  assert.equal(captured.evidence_refs.length, 1);
  assert.equal(captured.evidence_refs[0]?.kind, 'log');
  assert.ok(captured.evidence_refs[0]?.observation_context);
  assert.deepEqual(captured.result, result);

  const id = captured.evidence_refs[0]!.id;
  const report = ledger.resolveDraft(draft(id, 'Error fixture failure'));
  assert.equal(report.evidence[0]?.observation_context?.observed_platform, 'android');
  assert.equal(report.evidence[0]?.observation_context?.observed_version, '7.105.0');
  const restored = EvidenceLedger.restore(ledger.snapshot());
  assert.equal(restored.entries.get(id)?.observation_context?.entry_id, 'log-0123456789abcdef01234567');
});

test('unmatched remote logs and forged contexts are not admitted as evidence', () => {
  const ledger = new EvidenceLedger();
  const unmatched = remoteEntry({
    matched_identifiers: [],
    observation_context: {
      ...remoteEntry().observation_context,
      matched_identifiers: [],
      observed_platform: 'unknown',
    },
  });
  const captured = ledger.capture('search_cloud_logs', {}, {
    observation_status: 'uncorrelated',
    entries: [unmatched],
  }) as { evidence_refs: unknown[]; uncorrelated_entries_rejected: number; limitation: string };
  assert.deepEqual(captured.evidence_refs, []);
  assert.equal(captured.uncorrelated_entries_rejected, 1);
  assert.match(captured.limitation, /未进入证据账本/);

  ledger.capture('search_cloud_logs', {}, {
    entries: [{ excerpt: 'model invented log', observation_context: { forged: true } }],
  });
  assert.equal(ledger.entries.size, 0);
});

test('discovery observations are flattened and remote log capacity is explicit', () => {
  const ledger = new EvidenceLedger({ maxCurrentTurn: 1 });
  const second = remoteEntry({
    entry_id: 'log-89abcdef0123456789abcdef',
    excerpt: 'Error second fixture failure',
    observation_context: {
      ...remoteEntry().observation_context,
      entry_id: 'log-89abcdef0123456789abcdef',
    },
  });
  const captured = ledger.capture('discover_client_sessions', {}, {
    status: 'resolved',
    candidates: [{ entries: [remoteEntry(), second] }],
  }) as {
    evidence_refs: unknown[];
    observation_capacity_reached: boolean;
    limitation: string;
  };
  assert.equal(captured.evidence_refs.length, 1);
  assert.equal(captured.observation_capacity_reached, true);
  assert.match(captured.limitation, /容量/);
});

test('an unrelated remote log cannot support a root cause even if inserted into a restored ledger', () => {
  const ledger = new EvidenceLedger();
  const unrelated = remoteEntry({
    observation_context: {
      ...remoteEntry().observation_context,
      matched_identifiers: [],
      service_binding: { status: 'unconfirmed', method: null },
    },
  });
  const evidence = EvidenceSchema.parse({
    id: 'ev-unrelated-fixture',
    kind: 'log',
    source: 'logcenter:search_cloud_logs',
    location: unrelated.location,
    excerpt: unrelated.excerpt,
    supports: 'unrelated',
    observation_context: unrelated.observation_context,
  });
  ledger.add(evidence);
  assert.throws(
    () => ledger.resolveDraft(draft(evidence.id, 'Error fixture failure')),
    (error: unknown) => error instanceof EvidenceLedgerError && error.code === 'log_evidence_unrelated',
  );
});
