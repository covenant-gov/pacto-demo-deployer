import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identifierForClient } from './process.mjs';

// Mirrors pacto-app's scripts/dev-ports.mjs claim protocol: same claim
// directory, same index-<n>.claim.json shape ({ pid, branch, resolvedAt }),
// same O_EXCL create, same dead-pid + grace-window staleness rule. Both
// repos derive ports from the same 1420+10n/1421+10n/9223+100n formula over
// the same localhost port space, so this file must stay wire-compatible
// with pacto-app's claim files or the two stop seeing each other.
export const CLAIM_DIR = path.join(os.tmpdir(), 'pacto-dev-ports-claims');
export const CLAIM_GRACE_MS = 180_000;

export function claimPathForIndex(index, claimDir = CLAIM_DIR) {
  return path.join(claimDir, `index-${index}.claim.json`);
}

function isRecordPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is owned by someone else -- still alive.
    return err.code === 'EPERM';
  }
}

export function isClaimRecordStale(record, graceMs = CLAIM_GRACE_MS) {
  if (isRecordPidAlive(record.pid)) return false;
  const age = Date.now() - Number(record.resolvedAt);
  return !(Number.isFinite(age) && age >= 0 && age < graceMs);
}

export function readClaimRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Missing, unreadable, or mid-write from a racing claimant: treat as
    // "no live claim here".
    return null;
  }
}

export function writeClaimExclusive(filePath, record) {
  // O_EXCL is what makes this atomic: of any number of processes racing to
  // create the same path, the OS guarantees exactly one open() succeeds.
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeSync(fd, JSON.stringify(record));
  } finally {
    fs.closeSync(fd);
  }
}

function liveForeignClaim(index, branch, { claimDir = CLAIM_DIR, graceMs = CLAIM_GRACE_MS } = {}) {
  const record = readClaimRecord(claimPathForIndex(index, claimDir));
  if (!record || record.branch === branch) return null;
  return isClaimRecordStale(record, graceMs) ? null : record;
}

function foreignClaimError(index, record, claimDir) {
  return new Error(
    `refusing client ${index}: pacto-app sandbox '${record.branch}' holds a live dev-port claim ` +
      `on index ${index} (pid ${record.pid}, ${claimPathForIndex(index, claimDir)}). Ports ` +
      `${1420 + 10 * index}/${1421 + 10 * index}/${9223 + 100 * index} are spoken for. Stop that ` +
      `pacto-app sandbox, or launch this client with a different number.`,
  );
}

// Read direction: before binding a client's ports, refuse loudly if a live
// pacto-app claim on the same index belongs to a different branch. This
// repo's ports are pinned to the client number, so there is no "advance to
// the next index" fallback the way pacto-app has -- refusal is the only
// safe outcome.
export function assertClaimFree(index, { claimDir = CLAIM_DIR, graceMs = CLAIM_GRACE_MS } = {}) {
  const branch = identifierForClient(index);
  const record = liveForeignClaim(index, branch, { claimDir, graceMs });
  if (record) throw foreignClaimError(index, record, claimDir);
}

// Write direction: claim `index` for this client's long-lived process pid
// (the spawned `tauri dev` child, not the launcher). Reclaims a dead/expired
// claim or one already owned by this same client identity; throws the same
// loud refusal as assertClaimFree if a live foreign claim wins the race.
export function claimForClient(index, pid, { claimDir = CLAIM_DIR, graceMs = CLAIM_GRACE_MS } = {}) {
  const branch = identifierForClient(index);
  fs.mkdirSync(claimDir, { recursive: true });
  const target = claimPathForIndex(index, claimDir);
  const record = { pid, branch, resolvedAt: Date.now() };

  try {
    writeClaimExclusive(target, record);
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readClaimRecord(target);
  const ownedBySameBranch = existing && existing.branch === branch;
  if (existing && !ownedBySameBranch && !isClaimRecordStale(existing, graceMs)) {
    throw foreignClaimError(index, existing, claimDir);
  }

  // Stale, unreadable, or ours to reclaim: take it over. The unlink is
  // best-effort -- another racer may already have removed it -- the
  // exclusive create right after is what actually decides the single
  // winner when several processes reach this point at once.
  try {
    fs.unlinkSync(target);
  } catch {
    /* already gone */
  }
  try {
    writeClaimExclusive(target, record);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const raced = readClaimRecord(target);
    throw raced ? foreignClaimError(index, raced, claimDir) : err;
  }
}

// Release direction: best-effort, idempotent. Never throws on an
// already-gone file.
export function releaseClaimForClient(index, { claimDir = CLAIM_DIR } = {}) {
  try {
    fs.unlinkSync(claimPathForIndex(index, claimDir));
  } catch {
    /* already gone */
  }
}
