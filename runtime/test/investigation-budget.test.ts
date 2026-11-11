import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationBudgetTracker } from '../src/orchestration/budget.js';

test('调查预算统一限制远端调用、handoff 和 deadline', () => {
  const tracker = new InvestigationBudgetTracker({ maxSeconds: 10, maxRemoteCalls: 2 }, 1, 1_000);
  assert.equal(tracker.deadlineAt, 11_000);
  assert.equal(tracker.remainingMs(4_000), 7_000);
  assert.equal(tracker.tryConsumeRemoteCall(2_000), true);
  assert.equal(tracker.tryConsumeRemoteCall(3_000), true);
  assert.equal(tracker.tryConsumeRemoteCall(4_000), false);
  assert.equal(tracker.tryConsumeHandoff(4_000), true);
  assert.equal(tracker.tryConsumeHandoff(5_000), false);
  assert.deepEqual(tracker.snapshot(), {
    deadlineAt: 11_000,
    remoteCallsUsed: 2,
    handoffRoundsUsed: 1,
  });
  assert.equal(tracker.isExpired(10_999), false);
  assert.equal(tracker.isExpired(11_000), true);
  assert.equal(tracker.tryConsumeRemoteCall(11_000), false);
});
