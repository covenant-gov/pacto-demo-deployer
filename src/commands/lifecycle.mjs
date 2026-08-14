import fs from 'node:fs';
import path from 'node:path';
import {
  IDENTIFIER_RE,
  PIDS_FILE,
  STOP_GRACE_MS,
  parsePositiveInt,
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
import { cancelDemoBroadcast } from '../scenarios/index.mjs';

async function stopClients(state, { quiet = false } = {}) {
  const clients = state?.clients ?? [];
  if (clients.length === 0) {
    if (!quiet) log('no tracked clients');
    return;
  }
  for (const client of clients) {
    if (!isAlive(client.pid)) {
      if (!quiet) log(`client ${client.index}: already stopped (pid ${client.pid})`);
      continue;
    }
    await cancelDemoBroadcast(client, { quiet });
    if (!quiet) log(`client ${client.index}: stopping pid ${client.pid}`);
    stopPid(client.pid);
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (clients.every(c => !isAlive(c.pid))) break;
    await sleep(200);
  }
  for (const client of clients) {
    if (isAlive(client.pid)) {
      if (!quiet) log(`client ${client.index}: force-killing pid ${client.pid}`);
      killPid(client.pid);
    }
  }
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
    return;
  }
  const dirs = fs.readdirSync(root).filter(name => IDENTIFIER_RE.test(name)).sort((a, b) => {
    return Number(a.slice('io.pacto.demo.'.length)) - Number(b.slice('io.pacto.demo.'.length));
  });
  if (dirs.length === 0) {
    log('  (no io.pacto.demo.<n> directories)');
    return;
  }
  for (const name of dirs) {
    log(`  ${path.join(root, name)}`);
  }
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
    for (const dir of dirs) wipeDir(dir);
    return;
  }
  const index = parsePositiveInt(args.client, '--client');
  wipeDir(storageDirForClient(index));
}
