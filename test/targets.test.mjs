import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAccidentalInTreeWipePath,
  assertTargetsWipePath,
  dirSizeBytes,
  ensureCargoTargetsBudget,
  formatBytes,
  listAccidentalInTreeTargets,
  listTargetClientDirs,
  pruneOrphanTargetDirs,
  targetDirForClient,
  wipeAccidentalInTreeTarget,
  wipeAccidentalInTreeTargets,
  wipeAllTargets,
  wipeTargetsDir,
} from '../src/lib/targets.mjs';

function tmpTargetsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-targets-test-'));
}

function tmpDeployerTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-intree-test-'));
  const worktreesDir = path.join(root, 'worktrees');
  const appCacheDir = path.join(root, '.cache', 'pacto-app');
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(appCacheDir, { recursive: true });
  return { root, worktreesDir, appCacheDir };
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

test('listAccidentalInTreeTargets finds worktree and app-cache src-tauri/target', () => {
  const { worktreesDir, appCacheDir } = tmpDeployerTree();
  const wtTarget = path.join(worktreesDir, 'main', 'src-tauri', 'target');
  const cacheTarget = path.join(appCacheDir, 'src-tauri', 'target');
  writeFile(path.join(wtTarget, 'a.bin'), 8);
  writeFile(path.join(cacheTarget, 'b.bin'), 8);
  // Non-matching dirs must be ignored.
  writeFile(path.join(worktreesDir, 'main', 'other', 'target', 'x.bin'), 8);

  const found = listAccidentalInTreeTargets({ worktreesDir, appCacheDir });
  assert.deepStrictEqual(
    found.map(e => e.path).sort(),
    [cacheTarget, wtTarget].sort(),
  );
  assert.ok(found.some(e => e.label === 'worktree main'));
  assert.ok(found.some(e => e.label === 'app cache'));
});

test('assertAccidentalInTreeWipePath refuses escape and wrong shape', () => {
  const { worktreesDir, appCacheDir, root } = tmpDeployerTree();
  const ok = path.join(worktreesDir, 'feat', 'src-tauri', 'target');
  fs.mkdirSync(ok, { recursive: true });
  assert.strictEqual(
    assertAccidentalInTreeWipePath(ok, { worktreesDir, appCacheDir }),
    fs.realpathSync(ok),
  );

  assert.throws(
    () => assertAccidentalInTreeWipePath(path.join(root, 'outside', 'src-tauri', 'target'), {
      worktreesDir,
      appCacheDir,
    }),
    /escapes/,
  );
  assert.throws(
    () => assertAccidentalInTreeWipePath(path.join(worktreesDir, 'feat', 'src-tauri'), {
      worktreesDir,
      appCacheDir,
    }),
    /basename must be 'target'/,
  );
  const nested = path.join(worktreesDir, 'feat', 'src-tauri', 'target', 'debug');
  fs.mkdirSync(nested, { recursive: true });
  assert.throws(
    () => assertAccidentalInTreeWipePath(nested, { worktreesDir, appCacheDir }),
    /basename must be 'target'|parent must be 'src-tauri'|not worktrees/,
  );
});

test('wipeAccidentalInTreeTargets removes listed dirs only', () => {
  const { worktreesDir, appCacheDir } = tmpDeployerTree();
  const wtTarget = path.join(worktreesDir, 'main', 'src-tauri', 'target');
  const keep = path.join(worktreesDir, 'main', 'src-tauri', 'src');
  writeFile(path.join(wtTarget, 'a.bin'), 16);
  writeFile(path.join(keep, 'lib.rs'), 4);

  const wiped = wipeAccidentalInTreeTargets({ worktreesDir, appCacheDir });
  assert.deepStrictEqual(wiped, [wtTarget]);
  assert.ok(!fs.existsSync(wtTarget));
  assert.ok(fs.existsSync(path.join(keep, 'lib.rs')));
});

test('wipeAccidentalInTreeTarget refuses paths outside deployer roots', () => {
  const { worktreesDir, appCacheDir } = tmpDeployerTree();
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-foreign-'));
  const foreignTarget = path.join(foreign, 'src-tauri', 'target');
  fs.mkdirSync(foreignTarget, { recursive: true });
  assert.throws(
    () => wipeAccidentalInTreeTarget(foreignTarget, { worktreesDir, appCacheDir }),
    /escapes/,
  );
  assert.ok(fs.existsSync(foreignTarget));
});
