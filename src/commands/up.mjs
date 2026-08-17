import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DEMO_PIN,
  DEFAULT_READY_TIMEOUT_MS,
  FORBIDDEN_IDENTIFIERS,
  LOGS_DIR,
  MAX_CLIENTS,
  PIDS_FILE,
  loadSeedConfig,
  parsePositiveInt,
} from '../lib/config.mjs';
import { ensureAppClone, ensureWorktree, pnpmInstall, resolveRef } from '../lib/git.mjs';
import {
  launchEnv,
  readWindowTemplate,
  spawnClient,
  tauriOverlay,
  waitUntilReady,
} from '../lib/launch.mjs';
import {
  allPortsFree,
  identifierForClient,
  isAlive,
  log,
  portsForIndex,
  readPidsFile,
  storageDirForClient,
  writePidsFile,
} from '../lib/process.mjs';
import { assertClaimFree, claimForClient } from '../lib/claims.mjs';
import { demoNameForIndex, setupDemoName } from '../lib/session.mjs';
import { runScenario } from '../scenarios/index.mjs';
import { cmdDown } from './lifecycle.mjs';

export async function cmdUp(args, opts = {}) {
  const full = Boolean(opts.full) || Boolean(args.full) || args.command === 'up-full';
  log(full ? 'mode: up-full (login, broadcast, DMs, squad)' : 'mode: up (login, broadcast)');
  const seedConfig = loadSeedConfig(args);
  const pin = seedConfig.pin;
  const launchArgs = {
    ...args,
    pr: args.pr || seedConfig.pr,
    branch: args.branch || seedConfig.branch,
    clients: args.clients ?? seedConfig.clients,
  };
  if (seedConfig.loaded) {
    log(`seeds: ${seedConfig.envPath} (${seedConfig.byIndex.size} phrase(s))`);
  } else {
    log(`seeds: no .env at ${seedConfig.envPath} (copy .env.example to .env); extra clients stay fresh`);
  }
  const operatorKeys = Object.keys(seedConfig.operatorEnv ?? {});
  if (operatorKeys.length) {
    log(`operator env: ${operatorKeys.join(', ')}`);
  }

  if (launchArgs.clients == null || launchArgs.clients === '') {
    throw new Error('up requires --clients <n> or CLIENTS in .env');
  }
  const clients = parsePositiveInt(launchArgs.clients, '--clients');
  if (clients > MAX_CLIENTS) {
    throw new Error(`--clients must be <= ${MAX_CLIENTS}, got ${clients}`);
  }

  if (launchArgs.pr && launchArgs.branch) {
    throw new Error('--pr and --branch are mutually exclusive (also PR= and BRANCH= in .env)');
  }
  if (!launchArgs.pr && !launchArgs.branch) {
    throw new Error('up requires --pr <n> or --branch <name> (or PR= / BRANCH= in .env)');
  }

  for (let i = 1; i <= clients; i++) {
    identifierForClient(i);
    portsForIndex(i);
    storageDirForClient(i);
    assertClaimFree(i);
  }

  const existing = readPidsFile();
  const previousSha = existing?.ref?.sha || null;
  const previousLabel = existing?.ref?.label || null;
  if (existing?.clients?.some(c => isAlive(c.pid))) {
    log('stopping previous deployer session (storage kept)');
    await cmdDown({ quiet: true });
  } else if (existing) {
    if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
  }

  const appRepo = ensureAppClone(seedConfig.appRemote);
  const ref = resolveRef(launchArgs, appRepo, seedConfig.appRemote);
  if (previousSha && previousSha === ref.sha) {
    log(`checkout ${ref.repo} ${ref.label} @ ${ref.sha.slice(0, 12)} (unchanged)`);
  } else if (previousSha) {
    log(
      `checkout ${ref.repo} ${ref.label} @ ${previousSha.slice(0, 12)} → ${ref.sha.slice(0, 12)}` +
        (previousLabel && previousLabel !== ref.label ? ` (was ${previousLabel})` : ''),
    );
  } else {
    log(`checkout ${ref.repo} ${ref.label} @ ${ref.sha.slice(0, 12)}`);
  }
  const worktreePath = ensureWorktree(ref, appRepo);
  pnpmInstall(worktreePath);

  const windowTemplate = readWindowTemplate(worktreePath);
  const state = {
    startedAt: new Date().toISOString(),
    ref,
    worktree: worktreePath,
    clients: [],
  };

  for (let i = 1; i <= clients; i++) {
    const identifier = identifierForClient(i);
    const ports = portsForIndex(i);
    const mnemonic = seedConfig.byIndex.get(i) ?? null;
    const overlay = tauriOverlay(i, ports, windowTemplate);
    if (overlay.identifier !== identifier) {
      throw new Error('internal error: overlay identifier mismatch');
    }
    if (FORBIDDEN_IDENTIFIERS.has(overlay.identifier) || overlay.identifier === 'io.pacto') {
      throw new Error('internal error: overlay would collide with the main client');
    }

    assertClaimFree(i);
    if (!(await allPortsFree(ports))) {
      throw new Error(
        `ports for client ${i} are in use ` +
          `(${ports.devServer}/${ports.hmr}/${ports.mcpBridge}). ` +
          `Stop the occupant or run: node pacto-demo.mjs down`,
      );
    }

    const logPath = path.join(LOGS_DIR, `client-${i}.log`);
    const env = launchEnv(i, ports, mnemonic, pin, seedConfig.operatorEnv ?? {});
    if (env.PACTO_TEST_SANDBOX_ROOT || env.PACTO_DEV_WORLD) {
      throw new Error('internal error: sandbox env leaked into launch');
    }

    const kind = mnemonic ? 'seeded account' : 'fresh session (no mnemonic)';
    log(`launching client ${i} ${identifier} :${ports.devServer} — ${kind}`);
    const pid = spawnClient({ index: i, worktreePath, overlay, env, logPath });
    claimForClient(i, pid);
    const row = {
      index: i,
      identifier,
      pid,
      ports,
      log: logPath,
      seeded: Boolean(mnemonic),
      storage: storageDirForClient(i),
      name: demoNameForIndex(i),
      npub: null,
      broadcast: false,
    };
    state.clients.push(row);
    writePidsFile(state);

    log(`  pid ${pid}, waiting for compile (log: ${logPath})`);
    await waitUntilReady({ pid, ports, logPath, timeoutMs: DEFAULT_READY_TIMEOUT_MS });
    const sessionPin = (pin && String(pin).trim()) || DEFAULT_DEMO_PIN;
    try {
      await setupDemoName(row, sessionPin);
    } catch (err) {
      log(`  client ${i}: name/session failed: ${err.message}`);
    }
    writePidsFile(state);
  }

  const sessionPin = (pin && String(pin).trim()) || DEFAULT_DEMO_PIN;
  await runScenario('broadcast', { clients: state.clients, pin: sessionPin });
  if (full) {
    log('up-full: DMs + squad');
    await runScenario('dm', { clients: state.clients, pin: sessionPin });
    await runScenario('squad', { clients: state.clients, pin: sessionPin }, { all: false, name: args.name });
  }
  writePidsFile(state);
  log('');
  log(`launched ${clients} client(s). Storage persists until wipe.`);
  log('  node pacto-demo.mjs status');
  log('  node pacto-demo.mjs dm');
  log('  node pacto-demo.mjs squad');
  log('  node pacto-demo.mjs down');
}
