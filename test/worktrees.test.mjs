import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keptWorktreeSlugs,
  listWorktreeDirs,
  pruneStaleWorktrees,
} from '../src/lib/git.mjs';

function tmpWorktreesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-worktrees-test-'));
}

test('keptWorktreeSlugs always includes main plus the active slug', () => {
  assert.deepEqual([...keptWorktreeSlugs({ slug: 'pr-375' })].sort(), ['main', 'pr-375']);
  assert.deepEqual([...keptWorktreeSlugs({ slug: 'main' })].sort(), ['main']);
  assert.deepEqual([...keptWorktreeSlugs({ slug: 'feat-gov-ux' })].sort(), ['feat-gov-ux', 'main']);
});

test('pruneStaleWorktrees keeps main and current PR, removes others', () => {
  const root = tmpWorktreesDir();
  for (const slug of ['main', 'pr-346', 'pr-375', 'notes']) {
    fs.mkdirSync(path.join(root, slug));
    fs.writeFileSync(path.join(root, slug, 'marker'), slug);
  }

  const removed = pruneStaleWorktrees(
    { slug: 'pr-375' },
    null,
    {
      worktreesDir: root,
      removeWorktree: dir => fs.rmSync(dir, { recursive: true, force: true }),
    },
  );

  assert.deepEqual(removed.sort(), ['notes', 'pr-346']);
  assert.deepEqual(
    listWorktreeDirs(root).map(e => e.slug),
    ['main', 'pr-375'],
  );
  assert.ok(fs.existsSync(path.join(root, 'main', 'marker')));
  assert.ok(fs.existsSync(path.join(root, 'pr-375', 'marker')));
});

test('pruneStaleWorktrees when active is main only keeps main', () => {
  const root = tmpWorktreesDir();
  for (const slug of ['main', 'pr-100']) {
    fs.mkdirSync(path.join(root, slug));
  }

  const removed = pruneStaleWorktrees(
    { slug: 'main' },
    null,
    {
      worktreesDir: root,
      removeWorktree: dir => fs.rmSync(dir, { recursive: true, force: true }),
    },
  );

  assert.deepEqual(removed, ['pr-100']);
  assert.deepEqual(listWorktreeDirs(root).map(e => e.slug), ['main']);
});
