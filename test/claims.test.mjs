import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertClaimFree,
  claimForClient,
  claimPathForIndex,
  isClaimRecordStale,
  readClaimRecord,
  releaseClaimForClient,
  writeClaimExclusive,
} from '../src/lib/claims.mjs';

function tmpClaimDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-claims-test-'));
}

// A pid that recently existed but is now guaranteed dead, without touching
// any real long-running process on the machine.
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

test('a fresh claim succeeds and lands the exact documented JSON shape', () => {
  const claimDir = tmpClaimDir();
  claimForClient(3, 4242, { claimDir });

  const filePath = claimPathForIndex(3, claimDir);
  assert.ok(fs.existsSync(filePath));

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw).sort(), ['branch', 'pid', 'resolvedAt']);
  assert.strictEqual(raw.pid, 4242);
  assert.strictEqual(raw.branch, 'io.pacto.demo.3');
  assert.strictEqual(typeof raw.resolvedAt, 'number');
  assert.ok(raw.resolvedAt <= Date.now() && raw.resolvedAt > Date.now() - 5000);
});

test('a live foreign claim causes a loud refusal naming index, branch, and pid', () => {
  const claimDir = tmpClaimDir();
  const filePath = claimPathForIndex(5, claimDir);
  fs.mkdirSync(claimDir, { recursive: true });
  writeClaimExclusive(filePath, {
    pid: process.pid, // this test process is alive, so the claim is live
    branch: 'feat/some-pacto-app-branch',
    resolvedAt: Date.now(),
  });

  assert.throws(
    () => assertClaimFree(5, { claimDir }),
    err => {
      assert.match(err.message, /\b5\b/);
      assert.match(err.message, /feat\/some-pacto-app-branch/);
      assert.match(err.message, new RegExp(String(process.pid)));
      return true;
    },
  );

  // The write direction must refuse the same way, not silently overwrite.
  assert.throws(() => claimForClient(5, 9999, { claimDir }), /feat\/some-pacto-app-branch/);
});

test('a claim whose pid is dead and past grace does not block', () => {
  const claimDir = tmpClaimDir();
  const pid = deadPid();
  const filePath = claimPathForIndex(7, claimDir);
  fs.mkdirSync(claimDir, { recursive: true });
  const stale = { pid, branch: 'feat/long-gone-branch', resolvedAt: Date.now() - 200_000 };
  writeClaimExclusive(filePath, stale);

  assert.strictEqual(isClaimRecordStale(stale, 180_000), true);
  assert.doesNotThrow(() => assertClaimFree(7, { claimDir, graceMs: 180_000 }));

  // And the write direction reclaims it outright.
  claimForClient(7, 1234, { claimDir, graceMs: 180_000 });
  const record = readClaimRecord(filePath);
  assert.strictEqual(record.pid, 1234);
  assert.strictEqual(record.branch, 'io.pacto.demo.7');
});

test('a claim whose pid is dead but still within grace still blocks', () => {
  const claimDir = tmpClaimDir();
  const pid = deadPid();
  const filePath = claimPathForIndex(9, claimDir);
  fs.mkdirSync(claimDir, { recursive: true });
  const fresh = { pid, branch: 'feat/just-exited', resolvedAt: Date.now() };
  writeClaimExclusive(filePath, fresh);

  assert.strictEqual(isClaimRecordStale(fresh, 180_000), false);
  assert.throws(() => assertClaimFree(9, { claimDir, graceMs: 180_000 }), /feat\/just-exited/);
});

test('release is idempotent and never throws on an already-gone file', () => {
  const claimDir = tmpClaimDir();
  assert.doesNotThrow(() => releaseClaimForClient(11, { claimDir }));

  claimForClient(11, process.pid, { claimDir });
  assert.ok(fs.existsSync(claimPathForIndex(11, claimDir)));

  releaseClaimForClient(11, { claimDir });
  assert.ok(!fs.existsSync(claimPathForIndex(11, claimDir)));

  // Second release on the now-gone file must still not throw.
  assert.doesNotThrow(() => releaseClaimForClient(11, { claimDir }));
});

test('reclaiming the same client identity does not need the grace window', () => {
  const claimDir = tmpClaimDir();
  claimForClient(13, 111, { claimDir });
  // Same branch (io.pacto.demo.13), different pid, no grace elapsed:
  // this is a restart of our own client, not a foreign takeover.
  claimForClient(13, 222, { claimDir });
  const record = readClaimRecord(claimPathForIndex(13, claimDir));
  assert.strictEqual(record.pid, 222);
});

test('two racing claimants produce exactly one winner (real concurrent wx creates)', async () => {
  const claimDir = tmpClaimDir();
  const target = claimPathForIndex(17, claimDir);
  const RACERS = 8;

  const racerScript = `
    const fs = require('node:fs');
    try {
      const fd = fs.openSync(process.argv[1], 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, branch: 'racer', resolvedAt: Date.now() }));
      fs.closeSync(fd);
      process.stdout.write('WON');
    } catch (err) {
      process.stdout.write(err && err.code === 'EEXIST' ? 'LOST' : 'ERR:' + (err && err.code));
    }
  `;

  const results = await Promise.all(
    Array.from({ length: RACERS }, () => {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', racerScript, target], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', chunk => {
          out += chunk;
        });
        child.on('error', reject);
        child.on('close', () => resolve(out.trim()));
      });
    }),
  );

  const wins = results.filter(r => r === 'WON').length;
  const losses = results.filter(r => r === 'LOST').length;
  assert.strictEqual(wins, 1, `expected exactly one winner, got: ${results.join(',')}`);
  assert.strictEqual(losses, RACERS - 1);
  assert.ok(fs.existsSync(target));
});
