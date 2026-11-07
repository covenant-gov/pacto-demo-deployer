import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSeedConfig } from '../src/lib/config.mjs';

test('loadSeedConfig reads trust and install-script opt-ins from env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-trust-env-'));
  const envPath = path.join(dir, 'demo.env');
  fs.writeFileSync(
    envPath,
    [
      'PR=0',
      'CLIENTS=1',
      'PACTO_DEMO_TRUST_CHECKOUT=1',
      'PACTO_DEMO_ALLOW_INSTALL_SCRIPTS=yes',
      'ALCHEMY_RPC_KEY=alchemy-placeholder',
      '',
    ].join('\n'),
  );
  const cfg = loadSeedConfig({ envFile: envPath, seeds: [] });
  assert.equal(cfg.trustCheckout, '1');
  assert.equal(cfg.allowInstallScripts, 'yes');
  assert.equal(cfg.operatorEnv.ALCHEMY_RPC_KEY, 'alchemy-placeholder');
});
