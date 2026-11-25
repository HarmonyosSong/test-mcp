import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPendingFollowup } from '../src/lib/followup.ts';

test('consultations 中有 sent 状态即视为协查在途', () => {
  assert.equal(hasPendingFollowup({ consultations: [{ status: 'sent' }] }), true);
  assert.equal(
    hasPendingFollowup({ consultations: [{ status: 'completed' }, { status: 'sent' }] }),
    true,
  );
  assert.equal(hasPendingFollowup({ consultations: [{ status: 'completed' }] }), false);
  assert.equal(hasPendingFollowup({ consultations: [{ status: 'failed' }] }), false);
  assert.equal(hasPendingFollowup({ consultations: [{ status: 'unknown' }] }), false);
  assert.equal(hasPendingFollowup({ consultations: [] }), false);
  assert.equal(hasPendingFollowup({}), false);
});
