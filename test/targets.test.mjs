import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertTargetsWipePath,
  dirSizeBytes,
  ensureCargoTargetsBudget,
  formatBytes,
  listTargetClientDirs,
  pruneOrphanTargetDirs,
  targetDirForClient,
  wipeAllTargets,
  wipeTargetsDir,
} from '../src/lib/targets.mjs';

function tmpTargetsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-targets-test-'));
}

function writeFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
}

test('targetDirForClient stays under the targets root', () => {
  const root = tmpTargetsDir();
  const dir = targetDirForClient(2, root);
  assert.strictEqual(dir, path.join(root, '2'));
  assert.throws(() => targetDirForClient(0, root));
});

test('assertTargetsWipePath refuses escape and non-numeric dirs', () => {
  const root = tmpTargetsDir();
  const ok = path.join(root, '1');
  fs.mkdirSync(ok);
  assert.strictEqual(assertTargetsWipePath(ok, root), fs.realpathSync(ok));

  assert.throws(() => assertTargetsWipePath(root, root));
  assert.throws(() => assertTargetsWipePath(path.join(root, '..'), root));
  const stray = path.join(root, 'not-a-client');
  fs.mkdirSync(stray);
  assert.throws(() => assertTargetsWipePath(stray, root));
});

test('pruneOrphanTargetDirs keeps 1..N and removes higher indexes', () => {
  const root = tmpTargetsDir();
  for (const n of [1, 2, 3]) {
    writeFile(path.join(root, String(n), 'artifact.bin'), 16);
  }
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });

  pruneOrphanTargetDirs(2, root);

  assert.ok(fs.existsSync(path.join(root, '1')));
  assert.ok(fs.existsSync(path.join(root, '2')));
  assert.ok(!fs.existsSync(path.join(root, '3')));
  assert.ok(fs.existsSync(path.join(root, 'notes')));
  assert.deepStrictEqual(
    listTargetClientDirs(root).map(e => e.index),
    [1, 2],
  );
});

test('ensureCargoTargetsBudget wipes all on SHA mismatch', () => {
  const root = tmpTargetsDir();
  writeFile(path.join(root, '1', 'a.bin'), 32);
  writeFile(path.join(root, '2', 'b.bin'), 32);

  const result = ensureCargoTargetsBudget({
    clients: 2,
    previousSha: 'aaaaaaaaaaaaaaaa',
    nextSha: 'bbbbbbbbbbbbbbbb',
    targetsDir: root,
    maxBytes: 1024,
  });

  assert.strictEqual(result.wipedAll, true);
  assert.ok(!fs.existsSync(path.join(root, '1')));
  assert.ok(!fs.existsSync(path.join(root, '2')));
});

test('ensureCargoTargetsBudget wipes only over-budget same-SHA dirs', () => {
  const root = tmpTargetsDir();
  writeFile(path.join(root, '1', 'small.bin'), 10);
  writeFile(path.join(root, '2', 'big.bin'), 200);

  const result = ensureCargoTargetsBudget({
    clients: 2,
    previousSha: 'same-sha',
    nextSha: 'same-sha',
    targetsDir: root,
    maxBytes: 50,
  });

  assert.strictEqual(result.wipedAll, false);
  assert.deepStrictEqual(result.wipedClients, [2]);
  assert.ok(fs.existsSync(path.join(root, '1', 'small.bin')));
  assert.ok(!fs.existsSync(path.join(root, '2')));
});

test('ensureCargoTargetsBudget leaves under-budget same-SHA dirs alone', () => {
  const root = tmpTargetsDir();
  writeFile(path.join(root, '1', 'ok.bin'), 20);

  const result = ensureCargoTargetsBudget({
    clients: 1,
    previousSha: 'same-sha',
    nextSha: 'same-sha',
    targetsDir: root,
    maxBytes: 100,
  });

  assert.deepStrictEqual(result, { wipedAll: false, wipedClients: [] });
  assert.ok(fs.existsSync(path.join(root, '1', 'ok.bin')));
});

test('single-index cargo budget never wipes sibling dirs on SHA change', () => {
  const root = tmpTargetsDir();
  writeFile(path.join(root, '1', 'keep.bin'), 32);
  writeFile(path.join(root, '2', 'ok.bin'), 32);

  const result = ensureCargoTargetsBudget({
    indexes: [2],
    previousSha: 'aaaaaaaaaaaaaaaa',
    nextSha: 'bbbbbbbbbbbbbbbb',
    wipeAllOnShaChange: false,
    targetsDir: root,
    maxBytes: 1024,
  });

  assert.deepStrictEqual(result, { wipedAll: false, wipedClients: [] });
  assert.ok(fs.existsSync(path.join(root, '1', 'keep.bin')));
  assert.ok(fs.existsSync(path.join(root, '2', 'ok.bin')));
});

test('wipeAllTargets removes numeric client dirs and stray files', () => {
  const root = tmpTargetsDir();
  writeFile(path.join(root, '1', 'a.bin'), 8);
  fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
  wipeAllTargets(root);
  assert.ok(!fs.existsSync(path.join(root, '1')));
  assert.ok(!fs.existsSync(path.join(root, '.DS_Store')));
});

test('wipeTargetsDir and dirSizeBytes / formatBytes helpers', () => {
  const root = tmpTargetsDir();
  const dir = path.join(root, '1');
  writeFile(path.join(dir, 'a.bin'), 1024);
  assert.strictEqual(dirSizeBytes(dir), 1024);
  assert.match(formatBytes(1024), /KiB/);
  wipeTargetsDir(dir, root);
  assert.ok(!fs.existsSync(dir));
  assert.strictEqual(dirSizeBytes(dir), 0);
});
