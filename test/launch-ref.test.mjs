import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APP_BRANCH, normalizeLaunchRef } from '../src/lib/config.mjs';

test('PR=0 with no branch checks out pacto-app main', () => {
  assert.deepEqual(normalizeLaunchRef({ pr: '0' }), { pr: null, branch: DEFAULT_APP_BRANCH });
  assert.deepEqual(normalizeLaunchRef({ pr: 0 }), { pr: null, branch: DEFAULT_APP_BRANCH });
});

test('PR=0 with BRANCH uses the named branch', () => {
  assert.deepEqual(normalizeLaunchRef({ pr: '0', branch: 'feat/gov-ux' }), {
    pr: null,
    branch: 'feat/gov-ux',
  });
});

test('a real PR number stays a PR', () => {
  assert.deepEqual(normalizeLaunchRef({ pr: '123' }), { pr: '123', branch: null });
});

test('BRANCH alone stays a branch', () => {
  assert.deepEqual(normalizeLaunchRef({ branch: 'feat/gov-ux' }), {
    pr: null,
    branch: 'feat/gov-ux',
  });
});

test('a real PR and BRANCH together are refused', () => {
  assert.throws(
    () => normalizeLaunchRef({ pr: '123', branch: 'feat/gov-ux' }),
    /mutually exclusive/,
  );
});

test('missing PR and BRANCH is refused', () => {
  assert.throws(() => normalizeLaunchRef({}), /requires --pr/);
});
