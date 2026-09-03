import fs from 'node:fs';
import path from 'node:path';
import {
  APP_CACHE,
  DEFAULT_APP_BRANCH,
  WORKTREES_DIR,
  normalizeLaunchRef,
  parsePositiveInt,
} from './config.mjs';
import { commandExists, log, run, slugForRef } from './process.mjs';

function githubRepoSlug(remote) {
  const trimmed = String(remote).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  if (!match) {
    throw new Error(`PACTO_APP_REMOTE must be a GitHub URL (got ${remote})`);
  }
  return match[1];
}

function normalizeRemote(remote) {
  return String(remote).trim().replace(/\.git$/, '').replace(/\/+$/, '');
}

export function ensureAppClone(remote) {
  fs.mkdirSync(path.dirname(APP_CACHE), { recursive: true });
  const gitDir = path.join(APP_CACHE, '.git');

  if (!fs.existsSync(gitDir)) {
    if (fs.existsSync(APP_CACHE)) {
      throw new Error(`${APP_CACHE} exists but is not a git clone`);
    }
    log(`cloning ${remote} -> ${APP_CACHE}`);
    run('git', ['clone', '--filter=blob:none', remote, APP_CACHE], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return APP_CACHE;
  }

  const current = run('git', ['remote', 'get-url', 'origin'], { cwd: APP_CACHE });
  if (normalizeRemote(current) !== normalizeRemote(remote)) {
    log(`updating origin to ${remote}`);
    run('git', ['remote', 'set-url', 'origin', remote], { cwd: APP_CACHE });
  }
  log(`fetching ${remote}`);
  run('git', ['fetch', 'origin'], {
    cwd: APP_CACHE,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return APP_CACHE;
}

export function resolveRef(args, appRepo, remote) {
  const { pr, branch } = normalizeLaunchRef(args);
  const repo = githubRepoSlug(remote);

  if (pr) {
    const prNumber = parsePositiveInt(pr, '--pr');
    if (!commandExists('gh')) {
      throw new Error('gh is required for --pr (https://cli.github.com/)');
    }
    const raw = run('gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'headRefOid,headRefName,url,title',
    ]);
    const prInfo = JSON.parse(raw);
    run('git', ['fetch', 'origin', `pull/${prNumber}/head`], {
      cwd: appRepo,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const sha = prInfo.headRefOid || run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: appRepo });
    return {
      kind: 'pr',
      pr: prNumber,
      sha,
      name: prInfo.headRefName,
      slug: `pr-${prNumber}`,
      label: `PR #${prNumber} (${prInfo.headRefName})`,
      url: prInfo.url,
      repo,
    };
  }

  const name = String(branch).trim();
  run('git', ['fetch', 'origin', name], {
    cwd: appRepo,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const sha = run('git', ['rev-parse', `origin/${name}`], { cwd: appRepo });
  return {
    kind: 'branch',
    branch: name,
    sha,
    name,
    slug: slugForRef(name),
    label: `${repo}@${name}`,
    repo,
  };
}

export function ensureWorktree(ref, appRepo) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  run('git', ['worktree', 'prune'], { cwd: appRepo });

  const worktreePath = path.join(WORKTREES_DIR, ref.slug);
  const gitMarker = path.join(worktreePath, '.git');

  if (fs.existsSync(gitMarker)) {
    log(`updating worktree ${worktreePath} -> ${ref.sha.slice(0, 12)}`);
    run('git', ['checkout', '--detach', '--force', ref.sha], {
      cwd: worktreePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    run('git', ['reset', '--hard', ref.sha], { cwd: worktreePath });
    run('git', ['clean', '-fd', '-e', 'node_modules', '-e', 'src-tauri/target'], { cwd: worktreePath });
    pruneStaleWorktrees(ref, appRepo);
    return worktreePath;
  }

  if (fs.existsSync(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree`);
  }

  log(`creating detached worktree ${worktreePath} @ ${ref.sha.slice(0, 12)}`);
  run('git', ['worktree', 'add', '--detach', worktreePath, ref.sha], {
    cwd: appRepo,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  pruneStaleWorktrees(ref, appRepo);
  return worktreePath;
}

/** Slugs that must remain under worktrees/: main + the active PR/branch. */
export function keptWorktreeSlugs(ref) {
  const keep = new Set([slugForRef(DEFAULT_APP_BRANCH)]);
  if (ref?.slug) keep.add(String(ref.slug));
  return keep;
}

export function listWorktreeDirs(worktreesDir = WORKTREES_DIR) {
  if (!fs.existsSync(worktreesDir)) return [];
  return fs
    .readdirSync(worktreesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      slug: entry.name,
      path: path.join(worktreesDir, entry.name),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function defaultRemoveWorktree(dir, appRepo) {
  if (appRepo) {
    try {
      run('git', ['worktree', 'remove', '--force', dir], { cwd: appRepo });
      return;
    } catch {
      // Fall through: path may already be unregistered or half-deleted.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Keep only `main` and the active ref slug under worktrees/.
 * Previous PR/branch checkouts are removed so disk does not accumulate.
 */
export function pruneStaleWorktrees(ref, appRepo, {
  worktreesDir = WORKTREES_DIR,
  removeWorktree = defaultRemoveWorktree,
} = {}) {
  const keep = keptWorktreeSlugs(ref);
  const removed = [];
  for (const entry of listWorktreeDirs(worktreesDir)) {
    if (keep.has(entry.slug)) continue;
    log(`removing stale worktree ${entry.path} (keeping ${[...keep].join(', ')})`);
    removeWorktree(entry.path, appRepo);
    removed.push(entry.slug);
  }
  if (appRepo) {
    try {
      run('git', ['worktree', 'prune'], { cwd: appRepo });
    } catch {
      // Best-effort cleanup of already-gone registrations.
    }
  }
  return removed;
}

export function pnpmInstall(worktreePath) {
  log('pnpm install --frozen-lockfile');
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreePath, stdio: ['ignore', 'inherit', 'inherit'] });
}
