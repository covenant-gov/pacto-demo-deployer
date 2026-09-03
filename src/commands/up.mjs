import fs from 'node:fs';
import {
  DEFAULT_DEMO_PIN,
  DEFAULT_READY_TIMEOUT_MS,
  FORBIDDEN_IDENTIFIERS,
  PIDS_FILE,
  clientLogPath,
  launchIndexes,
  loadSeedConfig,
  normalizeLaunchRef,
  resolveRequiredClient,
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
  mergeClientRow,
  portsForIndex,
  readPidsFile,
  storageDirForClient,
  writePidsFile,
} from '../lib/process.mjs';
import { assertClaimFree, claimForClient } from '../lib/claims.mjs';
import { demoNameForIndex, setupDemoName } from '../lib/session.mjs';
import { ensureCargoTargetsBudget, pruneOrphanTargetDirs } from '../lib/targets.mjs';
import { runScenario } from '../scenarios/index.mjs';
import { cmdDown, stopTrackedClients } from './lifecycle.mjs';

function liveSiblings(existing, index) {
  return (existing?.clients ?? []).filter(c => c.index !== index && isAlive(c.pid));
}

/** Resolve launch mode from CLI command / opts. Exported for unit tests. */
export function resolveUpMode(args = {}, opts = {}) {
  const command = args.command ?? '';
  const onlyClient =
    Boolean(opts.onlyClient) ||
    command === 'up-client' ||
    command === 'up-simple-client' ||
    command === 'reload-client';
  const simple =
    Boolean(opts.simple) || command === 'up-simple' || command === 'up-simple-client';
  const full =
    !onlyClient && !simple && (Boolean(opts.full) || Boolean(args.full) || command === 'up-full');
  // up-client stays light; reload-client is session-only (like reload/up).
  const light =
    (!simple && onlyClient && command === 'up-client') ||
    Boolean(opts.light) ||
    Boolean(args.light) ||
    command === 'up-light';
  const doSession = !simple;
  const doBroadcast = !simple && (full || light);
  return { onlyClient, simple, full, light, doSession, doBroadcast };
}

async function spawnOneClient({
  index,
  worktreePath,
  windowTemplate,
  seedConfig,
  pin,
  state,
  doSession = true,
}) {
  const identifier = identifierForClient(index);
  const ports = portsForIndex(index);
  const mnemonic = seedConfig.byIndex.get(index) ?? null;
  const overlay = tauriOverlay(index, ports, windowTemplate);
  if (overlay.identifier !== identifier) {
    throw new Error('internal error: overlay identifier mismatch');
  }
  if (FORBIDDEN_IDENTIFIERS.has(overlay.identifier) || overlay.identifier === 'io.pacto') {
    throw new Error('internal error: overlay would collide with the main client');
  }

  assertClaimFree(index);
  if (!(await allPortsFree(ports))) {
    throw new Error(
      `ports for client ${index} are in use ` +
        `(${ports.devServer}/${ports.hmr}/${ports.mcpBridge}). ` +
        `Stop the occupant or run: node pacto-demo.mjs down`,
    );
  }

  const logPath = clientLogPath(index);
  const env = launchEnv(index, ports, mnemonic, pin, seedConfig.operatorEnv ?? {});
  if (env.PACTO_TEST_SANDBOX_ROOT || env.PACTO_DEV_WORLD) {
    throw new Error('internal error: sandbox env leaked into launch');
  }

  const kind = mnemonic ? 'seeded account' : 'fresh session (no mnemonic)';
  log(`launching client ${index} ${identifier} :${ports.devServer} — ${kind}`);
  const pid = spawnClient({ index, worktreePath, overlay, env, logPath });
  claimForClient(index, pid);
  const row = {
    index,
    identifier,
    pid,
    ports,
    log: logPath,
    seeded: Boolean(mnemonic),
    storage: storageDirForClient(index),
    name: demoNameForIndex(index),
    npub: null,
    broadcast: false,
  };
  Object.assign(state, mergeClientRow(state, row));
  writePidsFile(state);

  log(`  pid ${pid}, waiting for compile (log: ${logPath})`);
  await waitUntilReady({ pid, ports, logPath, timeoutMs: DEFAULT_READY_TIMEOUT_MS });
  const launched = state.clients.find(c => c.index === index) ?? row;
  if (doSession) {
    const sessionPin = (pin && String(pin).trim()) || DEFAULT_DEMO_PIN;
    try {
      await setupDemoName(launched, sessionPin);
    } catch (err) {
      log(`  client ${index}: name/session failed: ${err.message}`);
    }
    writePidsFile(state);
  }
  return launched;
}

export async function cmdUp(args, opts = {}) {
  const { onlyClient, simple, full, light, doSession, doBroadcast } = resolveUpMode(args, opts);
  const seedConfig = loadSeedConfig(args);
  const pin = seedConfig.pin;
  const launchArgs = {
    ...args,
    pr: args.pr || seedConfig.pr,
    branch: args.branch || seedConfig.branch,
    clients: args.clients ?? seedConfig.clients,
  };

  let indexes;
  if (onlyClient) {
    const n = resolveRequiredClient({
      cliValue: args.client,
      envValue: seedConfig.client,
      cliLabel: '--client',
      envLabel: 'CLIENT',
      error: `${args.command || 'up-client'} requires --client <n> or CLIENT in .env`,
    });
    indexes = launchIndexes({ onlyClient: n });
  } else {
    indexes = launchIndexes({ clients: launchArgs.clients });
  }

  log(
    onlyClient && simple
      ? `mode: up-simple-client (spawn only) client ${indexes[0]}`
      : onlyClient && light
        ? `mode: up-client (login, broadcast) client ${indexes[0]}`
        : onlyClient
          ? `mode: reload-client (login) client ${indexes[0]}`
          : simple
            ? 'mode: up-simple (spawn only)'
            : full
              ? 'mode: up-full (login, broadcast, DMs, squad)'
              : light
                ? 'mode: up-light (login, broadcast)'
                : 'mode: up (login)',
  );
  if (seedConfig.loaded) {
    log(`seeds: ${seedConfig.envPath} (${seedConfig.byIndex.size} phrase(s))`);
  } else {
    log(`seeds: no .env at ${seedConfig.envPath} (copy .env.example to .env); extra clients stay fresh`);
  }
  const operatorKeys = Object.keys(seedConfig.operatorEnv ?? {});
  if (operatorKeys.length) {
    log(`operator env: ${operatorKeys.join(', ')}`);
  }

  const refArgs = normalizeLaunchRef(launchArgs);
  launchArgs.pr = refArgs.pr;
  launchArgs.branch = refArgs.branch;

  for (const i of indexes) {
    identifierForClient(i);
    portsForIndex(i);
    storageDirForClient(i);
  }

  const existing = readPidsFile();
  const previousSha = existing?.ref?.sha || null;
  const previousLabel = existing?.ref?.label || null;
  const siblings = onlyClient ? liveSiblings(existing, indexes[0]) : [];

  if (!onlyClient) {
    for (const i of indexes) assertClaimFree(i);
    if (existing?.clients?.some(c => isAlive(c.pid))) {
      log('stopping previous deployer session (storage kept)');
      await cmdDown({ quiet: true });
    } else if (existing) {
      if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
    }
  } else {
    const n = indexes[0];
    const self = existing?.clients?.find(c => c.index === n);
    if (self && isAlive(self.pid)) {
      log(`stopping client ${n} only (storage kept)`);
      await stopTrackedClients([self], { quiet: true });
    }
  }

  let ref;
  let worktreePath;
  if (onlyClient && siblings.length > 0) {
    if (!existing?.worktree || !fs.existsSync(existing.worktree)) {
      throw new Error('live sibling clients need a worktree path in pids.json');
    }
    const appRepo = ensureAppClone(seedConfig.appRemote);
    const requested = resolveRef(launchArgs, appRepo, seedConfig.appRemote);
    if (existing.ref?.sha && requested.sha !== existing.ref.sha) {
      throw new Error(
        `single-client launch refuses to switch pacto-app (` +
          `${String(existing.ref.sha).slice(0, 12)} → ${String(requested.sha).slice(0, 12)}) ` +
          `while other clients are running. Stop them first, or match the live checkout.`,
      );
    }
    ref = existing.ref;
    worktreePath = existing.worktree;
    log(`reusing live worktree ${worktreePath} @ ${String(ref?.sha ?? '').slice(0, 12)}`);
  } else {
    const appRepo = ensureAppClone(seedConfig.appRemote);
    ref = resolveRef(launchArgs, appRepo, seedConfig.appRemote);
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
    worktreePath = ensureWorktree(ref, appRepo);
    pnpmInstall(worktreePath);
  }

  ensureCargoTargetsBudget({
    indexes,
    previousSha,
    nextSha: ref?.sha,
    wipeAllOnShaChange: !onlyClient,
  });
  if (!onlyClient) {
    pruneOrphanTargetDirs(indexes[indexes.length - 1]);
  }

  const windowTemplate = readWindowTemplate(worktreePath);
  const state = onlyClient
    ? {
        startedAt: existing?.startedAt || new Date().toISOString(),
        ref,
        worktree: worktreePath,
        clients: [...(existing?.clients ?? [])],
      }
    : {
        startedAt: new Date().toISOString(),
        ref,
        worktree: worktreePath,
        clients: [],
      };

  const launched = [];
  for (const i of indexes) {
    launched.push(
      await spawnOneClient({
        index: i,
        worktreePath,
        windowTemplate,
        seedConfig,
        pin,
        state,
        doSession,
      }),
    );
  }

  const sessionPin = (pin && String(pin).trim()) || DEFAULT_DEMO_PIN;
  if (doBroadcast) {
    await runScenario('broadcast', { clients: launched, pin: sessionPin });
  }
  if (full) {
    log('up-full: DMs + squad');
    await runScenario('dm', { clients: state.clients, pin: sessionPin });
    await runScenario('squad', { clients: state.clients, pin: sessionPin }, { all: false, name: args.name });
  }
  writePidsFile(state);
  log('');
  log(`launched ${indexes.length} client(s). Storage persists until wipe.`);
  log('  node pacto-demo.mjs status');
  log('  node pacto-demo.mjs dm');
  log('  node pacto-demo.mjs squad');
  log('  node pacto-demo.mjs down');
}
