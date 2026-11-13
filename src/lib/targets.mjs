import fs from 'node:fs';
import path from 'node:path';
import {
  APP_CACHE,
  MAX_TARGET_DIR_BYTES,
  TARGETS_DIR,
  WORKTREES_DIR,
} from './config.mjs';
import { log } from './process.mjs';

const CLIENT_DIR_RE = /^[1-9][0-9]*$/;

function resolveExistingRoot(root) {
  const resolved = path.resolve(root);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function isUnderRoot(resolved, resolvedRoot) {
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Accidental default Cargo dirs under deployer-owned trees.
 * Launcher sets CARGO_TARGET_DIR to targets/<n>, so any
 * worktrees/<slug>/src-tauri/target or .cache/pacto-app/src-tauri/target
 * is leftover from IDE/cargo in those trees.
 */
export function listAccidentalInTreeTargets({
  worktreesDir = WORKTREES_DIR,
  appCacheDir = APP_CACHE,
} = {}) {
  const found = [];
  const worktreesRoot = path.resolve(worktreesDir);
  if (fs.existsSync(worktreesRoot)) {
    for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(worktreesRoot, entry.name, 'src-tauri', 'target');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        found.push({
          path: candidate,
          label: `worktree ${entry.name}`,
        });
      }
    }
  }
  const cacheTarget = path.join(path.resolve(appCacheDir), 'src-tauri', 'target');
  if (fs.existsSync(cacheTarget) && fs.statSync(cacheTarget).isDirectory()) {
    found.push({
      path: cacheTarget,
      label: 'app cache',
    });
  }
  return found;
}

export function assertAccidentalInTreeWipePath(
  dir,
  { worktreesDir = WORKTREES_DIR, appCacheDir = APP_CACHE } = {},
) {
  const resolved = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  if (path.basename(resolved) !== 'target') {
    throw new Error(`refusing to wipe '${dir}': basename must be 'target'`);
  }
  if (path.basename(path.dirname(resolved)) !== 'src-tauri') {
    throw new Error(`refusing to wipe '${dir}': parent must be 'src-tauri'`);
  }

  const worktreesRoot = resolveExistingRoot(worktreesDir);
  const appCacheRoot = resolveExistingRoot(appCacheDir);
  const underWorktrees = isUnderRoot(resolved, worktreesRoot);
  const underCache = isUnderRoot(resolved, appCacheRoot);
  if (!underWorktrees && !underCache) {
    throw new Error(
      `refusing to wipe '${dir}': path escapes ${worktreesRoot} and ${appCacheRoot}`,
    );
  }
  if (underWorktrees) {
    // Expect worktrees/<slug>/src-tauri/target — three segments under worktrees root.
    const rel = path.relative(worktreesRoot, resolved);
    const parts = rel.split(path.sep);
    if (parts.length !== 3 || parts[1] !== 'src-tauri' || parts[2] !== 'target') {
      throw new Error(`refusing to wipe '${dir}': not worktrees/<slug>/src-tauri/target`);
    }
  }
  if (underCache && !underWorktrees) {
    const rel = path.relative(appCacheRoot, resolved);
    const parts = rel.split(path.sep);
    if (parts.length !== 2 || parts[0] !== 'src-tauri' || parts[1] !== 'target') {
      throw new Error(`refusing to wipe '${dir}': not .cache/pacto-app/src-tauri/target`);
    }
  }
  return resolved;
}

export function wipeAccidentalInTreeTarget(
  dir,
  { worktreesDir = WORKTREES_DIR, appCacheDir = APP_CACHE } = {},
) {
  const resolved = assertAccidentalInTreeWipePath(dir, { worktreesDir, appCacheDir });
  if (!fs.existsSync(resolved)) {
    log(`already absent: ${resolved}`);
    return;
  }
  const size = dirSizeBytes(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
  log(`wiped accidental in-tree cargo target ${resolved} (${formatBytes(size)})`);
}

export function wipeAccidentalInTreeTargets({
  worktreesDir = WORKTREES_DIR,
  appCacheDir = APP_CACHE,
} = {}) {
  const entries = listAccidentalInTreeTargets({ worktreesDir, appCacheDir });
  for (const entry of entries) {
    wipeAccidentalInTreeTarget(entry.path, { worktreesDir, appCacheDir });
  }
  return entries.map(e => e.path);
}

export function targetDirForClient(index, targetsDir = TARGETS_DIR) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`target client index must be >= 1, got ${index}`);
  }
  const root = path.resolve(targetsDir);
  const dir = path.resolve(root, String(n));
  if (dir === root || !dir.startsWith(root + path.sep)) {
    throw new Error(`target path escapes targets root: ${dir}`);
  }
  if (path.basename(dir) !== String(n)) {
    throw new Error(`target path basename mismatch: ${dir}`);
  }
  return dir;
}

export function listTargetClientDirs(targetsDir = TARGETS_DIR) {
  if (!fs.existsSync(targetsDir)) return [];
  return fs
    .readdirSync(targetsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && CLIENT_DIR_RE.test(entry.name))
    .map(entry => ({
      index: Number(entry.name),
      path: path.join(targetsDir, entry.name),
    }))
    .sort((a, b) => a.index - b.index);
}

export function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // Race with concurrent cargo writes: skip unreadable entries.
      }
    }
  }
  return total;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function assertTargetsWipePath(dir, targetsDir = TARGETS_DIR) {
  const root = path.resolve(targetsDir);
  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const resolved = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);

  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing to wipe '${dir}': path escapes ${resolvedRoot}`);
  }
  const base = path.basename(resolved);
  if (!CLIENT_DIR_RE.test(base)) {
    throw new Error(`refusing to wipe '${dir}': not a numeric client target dir`);
  }
  return resolved;
}

export function wipeTargetsDir(dir, targetsDir = TARGETS_DIR) {
  const resolved = assertTargetsWipePath(dir, targetsDir);
  if (!fs.existsSync(resolved)) {
    log(`already absent: ${resolved}`);
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  log(`wiped cargo targets ${resolved}`);
}

export function wipeAllTargets(targetsDir = TARGETS_DIR) {
  if (!fs.existsSync(targetsDir)) {
    log(`already absent: ${targetsDir}`);
    return;
  }
  const root = path.resolve(targetsDir);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && CLIENT_DIR_RE.test(entry.name)) {
      wipeTargetsDir(full, targetsDir);
      continue;
    }
    // Drop stray files (e.g. .DS_Store) under targets/ only.
    if (entry.isFile()) {
      fs.rmSync(full, { force: true });
    }
  }
}

export function pruneOrphanTargetDirs(clients, targetsDir = TARGETS_DIR) {
  const n = Number(clients);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`clients must be >= 1, got ${clients}`);
  }
  for (const entry of listTargetClientDirs(targetsDir)) {
    if (entry.index > n) {
      wipeTargetsDir(entry.path, targetsDir);
    }
  }
}

/**
 * Bound cargo artifact growth before spawn.
 * - SHA change → wipe every client target dir
 * - Per-client size over maxBytes → wipe that dir
 * Orphan prune is separate (caller should still run pruneOrphanTargetDirs).
 */
export function ensureCargoTargetsBudget({
  clients,
  indexes = null,
  previousSha = null,
  nextSha = null,
  wipeAllOnShaChange = true,
  targetsDir = TARGETS_DIR,
  maxBytes = MAX_TARGET_DIR_BYTES,
} = {}) {
  let targetIndexes;
  if (indexes != null) {
    targetIndexes = [...indexes].map(i => {
      const n = Number(i);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`target client index must be >= 1, got ${i}`);
      }
      return n;
    });
    if (targetIndexes.length === 0) {
      throw new Error('indexes must be a non-empty list');
    }
  } else {
    const n = Number(clients);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`clients must be >= 1, got ${clients}`);
    }
    targetIndexes = Array.from({ length: n }, (_, i) => i + 1);
  }

  const shaChanged = Boolean(previousSha && nextSha && previousSha !== nextSha);
  if (shaChanged && wipeAllOnShaChange) {
    log(
      `cargo targets: pacto-app SHA changed ` +
        `(${String(previousSha).slice(0, 12)} → ${String(nextSha).slice(0, 12)}); wiping ${targetsDir}`,
    );
    wipeAllTargets(targetsDir);
    return { wipedAll: true, wipedClients: [] };
  }

  const wipedClients = [];
  for (const i of targetIndexes) {
    const dir = targetDirForClient(i, targetsDir);
    if (!fs.existsSync(dir)) continue;
    const size = dirSizeBytes(dir);
    if (size > maxBytes) {
      log(
        `cargo targets: client ${i} is ${formatBytes(size)} ` +
          `(cap ${formatBytes(maxBytes)}); wiping ${dir}`,
      );
      wipeTargetsDir(dir, targetsDir);
      wipedClients.push(i);
    }
  }
  return { wipedAll: false, wipedClients };
}
