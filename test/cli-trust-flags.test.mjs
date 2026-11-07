import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageText } from '../src/lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'pacto-demo.mjs');

test('usageText documents trust-checkout and ignore-scripts limits', () => {
  const text = usageText();
  assert.match(text, /--trust-checkout/);
  assert.match(text, /--allow-install-scripts/);
  assert.match(text, /ignore-scripts/);
  assert.match(text, /OPERATOR_TRUST_BOUNDARY/);
});

test('help exit lists new flags (no deploy)', () => {
  const result = spawnSync(process.execPath, [script, 'help'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--trust-checkout/);
  assert.match(result.stdout, /--allow-install-scripts/);
});

test('unknown flag still fails without running install', () => {
  const result = spawnSync(process.execPath, [script, 'up', '--not-a-real-flag'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /unknown flag/);
});
