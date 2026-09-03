import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  IDENTIFIER_RE,
  PIDS_FILE,
  STOP_GRACE_MS,
  TARGETS_DIR,
  clientLogPath,
  loadSeedConfig,
  parsePositiveInt,
  resolveRequiredClient,
} from '../lib/config.mjs';
import {
  appDataRoot,
  isAlive,
  killPid,
  listWipeableStorageDirs,
  log,
  readPidsFile,
  sleep,
  stopPid,
  storageDirForClient,
  wipeDir,
} from '../lib/process.mjs';
import { releaseClaimForClient } from '../lib/claims.mjs';
import {
  dirSizeBytes,
  formatBytes,
  listTargetClientDirs,
  wipeAllTargets,
} from '../lib/targets.mjs';
import { cancelDemoBroadcast } from '../scenarios/index.mjs';

export async function stopTrackedClients(clients, { quiet = false } = {}) {
  const rows = clients ?? [];
  if (rows.length === 0) {
    if (!quiet) log('no tracked clients');
    return;
  }
  for (const client of rows) {
    if (!isAlive(client.pid)) {
      if (!quiet) log(`client ${client.index}: already stopped (pid ${client.pid})`);
      releaseClaimForClient(client.index);
      continue;
    }
    await cancelDemoBroadcast(client, { quiet });
    if (!quiet) log(`client ${client.index}: stopping pid ${client.pid}`);
    stopPid(client.pid);
    releaseClaimForClient(client.index);
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (rows.every(c => !isAlive(c.pid))) break;
    await sleep(200);
  }
  for (const client of rows) {
    if (isAlive(client.pid)) {
      if (!quiet) log(`client ${client.index}: force-killing pid ${client.pid}`);
      killPid(client.pid);
    }
  }
}

async function stopClients(state, { quiet = false } = {}) {
  await stopTrackedClients(state?.clients ?? [], { quiet });
}

export async function cmdDown({ quiet = false, wipe = false } = {}) {
  const state = readPidsFile();
  if (!state) {
    if (!quiet) log('no pids.json — nothing to stop');
  } else {
    await stopClients(state, { quiet });
    if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
    if (!quiet) log(wipe ? 'stopped.' : 'stopped. storage was not wiped.');
  }
  if (wipe) cmdWipe({ all: true });
}

export function cmdLogs(args, { spawnFn = spawn } = {}) {
  const seedConfig = loadSeedConfig(args);
  const index = resolveRequiredClient({
    cliValue: args.client,
    envValue: seedConfig.logClient,
    cliLabel: '--client',
    envLabel: 'LOG_CLIENT',
    error: 'logs requires --client <n> or LOG_CLIENT in .env',
  });
  const logPath = clientLogPath(index);
  if (!fs.existsSync(logPath)) {
    throw new Error(`no log file at ${logPath}`);
  }
  log(`following ${logPath} (Ctrl+C to stop)`);
  const child = spawnFn('tail', ['-F', logPath], { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || code == null) resolve();
      else reject(new Error(`tail exited ${signal ? signal : code}`));
    });
  });
}

export function cmdStatus() {
  const state = readPidsFile();
  if (!state) {
    log('no running deployer session (pids.json missing)');
  } else {
    log(`ref: ${state.ref?.label ?? '(unknown)'} @ ${state.ref?.sha?.slice(0, 12) ?? '?'}`);
    log(`worktree: ${state.worktree}`);
    log(`started: ${state.startedAt}`);
    for (const client of state.clients ?? []) {
      const alive = isAlive(client.pid) ? 'running' : 'stopped';
      const seeded = client.seeded ? 'seeded' : 'fresh';
      const who = client.name ? ` ${client.name}` : '';
      log(
        `  client ${client.index}: ${alive} pid=${client.pid} ${client.identifier}${who} ` +
          `dev=${client.ports.devServer} ${seeded}`,
      );
    }
  }

  log('storage:');
  const root = appDataRoot();
  if (!fs.existsSync(root)) {
    log(`  (no app-data root at ${root})`);
  } else {
    const dirs = fs.readdirSync(root).filter(name => IDENTIFIER_RE.test(name)).sort((a, b) => {
      return Number(a.slice('io.pacto.demo.'.length)) - Number(b.slice('io.pacto.demo.'.length));
    });
    if (dirs.length === 0) {
      log('  (no io.pacto.demo.<n> directories)');
    } else {
      for (const name of dirs) {
        log(`  ${path.join(root, name)}`);
      }
    }
  }

  log('cargo targets:');
  const targetDirs = listTargetClientDirs();
  if (targetDirs.length === 0) {
    log(`  (none under ${TARGETS_DIR})`);
    return;
  }
  let total = 0;
  for (const entry of targetDirs) {
    const size = dirSizeBytes(entry.path);
    total += size;
    log(`  client ${entry.index}: ${formatBytes(size)}  ${entry.path}`);
  }
  log(`  total: ${formatBytes(total)}`);
}

export function cmdCleanTargets() {
  wipeAllTargets();
  log(`cargo targets cleaned under ${TARGETS_DIR}`);
}

export function cmdWipe(args) {
  if (args.all && args.client != null) {
    throw new Error('use either --client <n> or --all, not both');
  }
  if (!args.all && args.client == null) {
    throw new Error('wipe requires --client <n> or --all');
  }
  if (args.all) {
    const dirs = listWipeableStorageDirs();
    if (dirs.length === 0) {
      log('no io.pacto.demo.<n> directories to wipe');
      return;
    }
    for (const dir of dirs) {
      wipeDir(dir);
      releaseClaimForClient(Number(path.basename(dir).slice('io.pacto.demo.'.length)));
    }
    return;
  }
  const index = parsePositiveInt(args.client, '--client');
  wipeDir(storageDirForClient(index));
  releaseClaimForClient(index);
}
