import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_OPERATOR_ENV_KEYS,
  applyOperatorEnv,
  operatorEnvFromVars,
} from '../src/lib/config.mjs';
import { launchEnv } from '../src/lib/launch.mjs';

test('operatorEnvFromVars keeps allowlisted keys and drops seeds and sandbox', () => {
  const out = operatorEnvFromVars({
    ALCHEMY_RPC_KEY: '  alchemy-secret  ',
    PIMLICO_API_KEY: 'pimlico-secret',
    PACTO_DEMO_SEED_1: 'word word word',
    PACTO_TEST_SANDBOX_ROOT: '/tmp/nope',
    PACTO_DEV_WORLD: '1',
    POCKET_RPC_KEY: '',
    UNKNOWN_KEY: 'nope',
  });
  assert.deepEqual(out, {
    ALCHEMY_RPC_KEY: 'alchemy-secret',
    PIMLICO_API_KEY: 'pimlico-secret',
  });
  assert.ok(APP_OPERATOR_ENV_KEYS.includes('ALCHEMY_RPC_KEY'));
});

test('applyOperatorEnv does not override a live shell value', () => {
  const env = { ALCHEMY_RPC_KEY: 'from-shell' };
  applyOperatorEnv(env, { ALCHEMY_RPC_KEY: 'from-file', PIMLICO_API_KEY: 'from-file' });
  assert.equal(env.ALCHEMY_RPC_KEY, 'from-shell');
  assert.equal(env.PIMLICO_API_KEY, 'from-file');
});

test('launchEnv forwards operator keys and still strips sandbox vars', () => {
  const previous = process.env.ALCHEMY_RPC_KEY;
  delete process.env.ALCHEMY_RPC_KEY;
  try {
    const env = launchEnv(
      1,
      { devServer: 1430, hmr: 1431, mcpBridge: 9323 },
      null,
      '123456',
      {
        ALCHEMY_RPC_KEY: 'alchemy-secret',
        PACTO_TEST_SANDBOX_ROOT: '/tmp/nope',
      },
    );
    assert.equal(env.ALCHEMY_RPC_KEY, 'alchemy-secret');
    assert.equal(env.PACTO_TEST_SANDBOX_ROOT, undefined);
    assert.equal(env.PACTO_DEV_WORLD, undefined);
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_RPC_KEY;
    else process.env.ALCHEMY_RPC_KEY = previous;
  }
});
