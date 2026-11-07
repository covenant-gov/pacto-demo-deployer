import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APP_REMOTE } from '../src/lib/config.mjs';
import {
  assertCheckoutConsent,
  checkoutNeedsTrustConsent,
  isDefaultAppRemote,
  isOptInTruthy,
  pnpmInstallArgs,
  resolveAllowInstallScripts,
  scrubChildEnv,
} from '../src/lib/trust.mjs';

test('isOptInTruthy accepts common affirmative spellings only', () => {
  assert.equal(isOptInTruthy('1'), true);
  assert.equal(isOptInTruthy('true'), true);
  assert.equal(isOptInTruthy('YES'), true);
  assert.equal(isOptInTruthy('on'), true);
  assert.equal(isOptInTruthy(true), true);
  assert.equal(isOptInTruthy('0'), false);
  assert.equal(isOptInTruthy('false'), false);
  assert.equal(isOptInTruthy(''), false);
  assert.equal(isOptInTruthy(null), false);
  assert.equal(isOptInTruthy('maybe'), false);
});

test('checkoutNeedsTrustConsent for PR and foreign remote only', () => {
  assert.equal(
    checkoutNeedsTrustConsent({ kind: 'pr', pr: 42 }, DEFAULT_APP_REMOTE),
    true,
  );
  assert.equal(
    checkoutNeedsTrustConsent({ kind: 'branch', branch: 'main' }, DEFAULT_APP_REMOTE),
    false,
  );
  assert.equal(
    checkoutNeedsTrustConsent(
      { kind: 'branch', branch: 'main' },
      'https://github.com/example/fork-pacto-app.git',
    ),
    true,
  );
  assert.equal(isDefaultAppRemote(DEFAULT_APP_REMOTE), true);
  assert.equal(isDefaultAppRemote('https://github.com/covenant-gov/pacto-app'), true);
  assert.equal(isDefaultAppRemote('https://github.com/other/pacto-app.git'), false);
});

test('assertCheckoutConsent refuses PR without opt-in and accepts with flag', () => {
  const ref = { kind: 'pr', pr: 99, url: 'https://github.com/covenant-gov/pacto-app/pull/99' };
  assert.throws(
    () => assertCheckoutConsent({ ref, remote: DEFAULT_APP_REMOTE, trusted: false }),
    /--trust-checkout|PACTO_DEMO_TRUST_CHECKOUT/,
  );
  assert.throws(
    () => assertCheckoutConsent({ ref, remote: DEFAULT_APP_REMOTE, trusted: false }),
    /not a safety|does not sandbox/i,
  );
  assert.equal(
    assertCheckoutConsent({ ref, remote: DEFAULT_APP_REMOTE, trusted: '1' }),
    true,
  );
  assert.equal(
    assertCheckoutConsent({
      ref: { kind: 'branch', branch: 'main' },
      remote: DEFAULT_APP_REMOTE,
      trusted: false,
    }),
    false,
  );
});

test('pnpmInstallArgs defaults to ignore-scripts and opt-in removes it', () => {
  assert.deepEqual(pnpmInstallArgs(), ['install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual(pnpmInstallArgs({ allowInstallScripts: false }), [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  assert.deepEqual(pnpmInstallArgs({ allowInstallScripts: true }), [
    'install',
    '--frozen-lockfile',
  ]);
  assert.equal(resolveAllowInstallScripts('yes'), true);
  assert.equal(resolveAllowInstallScripts(undefined), false);
});

test('scrubChildEnv drops denylisted credentials and seed slots, keeps PATH', () => {
  const scrubbed = scrubChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/demo',
    GITHUB_TOKEN: 'ghs_placeholder_not_real',
    GH_TOKEN: 'ghs_placeholder_not_real',
    NPM_TOKEN: 'npm_placeholder',
    AWS_SECRET_ACCESS_KEY: 'aws_placeholder',
    PACTO_DEMO_SEED_1: 'alpha bravo charlie',
    ALCHEMY_RPC_KEY: 'alchemy-placeholder',
    LANG: 'C',
  });
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.HOME, '/home/demo');
  assert.equal(scrubbed.LANG, 'C');
  assert.equal(scrubbed.ALCHEMY_RPC_KEY, 'alchemy-placeholder');
  assert.equal(scrubbed.GITHUB_TOKEN, undefined);
  assert.equal(scrubbed.GH_TOKEN, undefined);
  assert.equal(scrubbed.NPM_TOKEN, undefined);
  assert.equal(scrubbed.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(scrubbed.PACTO_DEMO_SEED_1, undefined);
});
