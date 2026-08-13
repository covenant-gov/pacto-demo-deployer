#!/usr/bin/env node
/**
 * Multi-client Pacto demo deployer.
 *
 * Standalone launcher: clones covenant-gov/pacto-app, checks out a GitHub
 * branch or PR into a detached worktree, then launches N isolated `tauri dev`
 * clients with unique io.pacto.demo.<n> identifiers. Never uses or deletes
 * io.pacto (the main client).
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEPLOYER_DIR = path.dirname(__filename);
const APP_CACHE = path.join(DEPLOYER_DIR, '.cache', 'pacto-app');
const DEFAULT_APP_REMOTE = 'https://github.com/covenant-gov/pacto-app.git';

const WORKTREES_DIR = path.join(DEPLOYER_DIR, 'worktrees');
const TARGETS_DIR = path.join(DEPLOYER_DIR, 'targets');
const LOGS_DIR = path.join(DEPLOYER_DIR, 'logs');
const PIDS_FILE = path.join(DEPLOYER_DIR, 'pids.json');

const IDENTIFIER_RE = /^io\.pacto\.demo\.[1-9][0-9]*$/;
const FORBIDDEN_IDENTIFIERS = new Set(['io.pacto', 'io.pacto.demo']);

const BASE_DEV_SERVER = 1420;
const BASE_HMR = 1421;
const BASE_MCP_BRIDGE = 9223;
const PORT_STRIDE = 10;
const BRIDGE_STRIDE = 100;
// Index 30 derives Chromium-blocked port 1720; cap below that.
const MAX_CLIENTS = 29;
const UNSAFE_BROWSER_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const DEFAULT_READY_TIMEOUT_MS = Number(process.env.PACTO_DEMO_READY_TIMEOUT_MS) || 15 * 60 * 1000;
const STOP_GRACE_MS = 5_000;
const PORT_POLL_MS = 1_000;
const DEFAULT_ENV_FILE = path.join(DEPLOYER_DIR, '.env');
const SEED_ENV_RE = /^PACTO_DEMO_SEED_([1-9][0-9]*)$/;

const USAGE = `Pacto demo deployer — isolated parallel clients (never touches io.pacto)

PRs and branches are from https://github.com/covenant-gov/pacto-app
(cloned into .cache/pacto-app on first up).

Usage:
  cp .env.example .env          # then set PACTO_DEMO_SEED_1, _2, ...
  node pacto-demo.mjs up --pr <n> --clients <n>
  node pacto-demo.mjs up --branch <name> --clients <n>
  node pacto-demo.mjs down
  node pacto-demo.mjs status
  node pacto-demo.mjs wipe --client <n>
  node pacto-demo.mjs wipe --all

Options:
  --pr <n>              GitHub PR number on covenant-gov/pacto-app (mutually exclusive with --branch)
  --branch <name>       Remote branch on covenant-gov/pacto-app (mutually exclusive with --pr)
  --clients <n>         Number of desktop clients to launch (1..${MAX_CLIENTS})
  --env <path>          Env file with PACTO_DEMO_SEED_N (default: .env next to this script)
  --seed "<phrase>"     Repeatable; overrides PACTO_DEMO_SEED_1, then _2, ...
  --pin <pin>           Dev autologin PIN (default: PACTO_DEMO_PIN or 123456)
  --client <n>          Wipe storage for io.pacto.demo.<n> only
  --all                 Wipe every io.pacto.demo.<n> directory

Makefile:
  make up PR=123 CLIENTS=3
  make wipe CLIENT=1
  make wipe-all
  make down
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(message);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    const joined = `${cmd} ${args.join(' ')}`;
    throw new Error(detail ? `${joined} failed:\n${detail}` : `${joined} failed (exit ${result.status})`);
  }
  return (result.stdout || '').trim();
}

function commandExists(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function slugForRef(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '-');
}

function identifierForClient(index) {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`client index must be an integer >= 1, got ${index}`);
  }
  const identifier = `io.pacto.demo.${index}`;
  assertSafeIdentifier(identifier);
  return identifier;
}

function assertSafeIdentifier(identifier) {
  if (FORBIDDEN_IDENTIFIERS.has(identifier)) {
    throw new Error(`refusing identifier '${identifier}' (reserved for the main client)`);
  }
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`refusing identifier '${identifier}' (must match io.pacto.demo.<n> with n >= 1)`);
  }
}

function portsForIndex(index) {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`port index must be an integer >= 1 (index 0 is reserved for io.pacto), got ${index}`);
  }
  const ports = {
    devServer: BASE_DEV_SERVER + index * PORT_STRIDE,
    hmr: BASE_HMR + index * PORT_STRIDE,
    mcpBridge: BASE_MCP_BRIDGE + index * BRIDGE_STRIDE,
  };
  assertSafePorts(ports);
  return ports;
}

function assertSafePorts(ports) {
  if (
    ports.devServer === BASE_DEV_SERVER ||
    ports.hmr === BASE_HMR ||
    ports.mcpBridge === BASE_MCP_BRIDGE
  ) {
    throw new Error(
      `refusing reserved main-client ports 1420/1421/9223 (got ${ports.devServer}/${ports.hmr}/${ports.mcpBridge})`,
    );
  }
  if (
    UNSAFE_BROWSER_PORTS.has(ports.devServer) ||
    UNSAFE_BROWSER_PORTS.has(ports.hmr) ||
    UNSAFE_BROWSER_PORTS.has(ports.mcpBridge)
  ) {
    throw new Error(
      `refusing browser-blocked ports ${ports.devServer}/${ports.hmr}/${ports.mcpBridge}`,
    );
  }
}

function appDataRoot() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    default:
      return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

function storageDirForClient(index) {
  const identifier = identifierForClient(index);
  const root = path.resolve(appDataRoot());
  const dir = path.resolve(root, identifier);
  if (dir === root || !dir.startsWith(root + path.sep)) {
    throw new Error(`storage path escapes app-data root: ${dir}`);
  }
  if (path.basename(dir) !== identifier) {
    throw new Error(`storage path basename mismatch: ${dir}`);
  }
  return dir;
}

function assertWipePath(dir) {
  const identifier = path.basename(dir);
  assertSafeIdentifier(identifier);

  const root = path.resolve(appDataRoot());
  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const resolved = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);

  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing to wipe '${dir}': path escapes ${resolvedRoot}`);
  }
  assertSafeIdentifier(path.basename(resolved));
  return resolved;
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function isPortListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function allPortsFree(ports) {
  const [devServer, hmr, mcpBridge] = await Promise.all([
    isPortFree(ports.devServer),
    isPortFree(ports.hmr),
    isPortFree(ports.mcpBridge),
  ]);
  return devServer && hmr && mcpBridge;
}

function parseArgs(argv) {
  const out = {
    command: 'help',
    pr: null,
    branch: null,
    clients: null,
    envFile: null,
    seeds: [],
    pin: null,
    client: null,
    all: false,
  };
  const rest = argv.slice(2);
  if (rest.length === 0) return out;

  const first = rest[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    out.command = 'help';
    return out;
  }
  out.command = first;

  const take = (flag, i, args) => {
    const value = args[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--pr':
        out.pr = take(arg, i, rest);
        i += 1;
        break;
      case '--branch':
        out.branch = take(arg, i, rest);
        i += 1;
        break;
      case '--clients':
        out.clients = take(arg, i, rest);
        i += 1;
        break;
      case '--env':
        out.envFile = take(arg, i, rest);
        i += 1;
        break;
      case '--seed':
        out.seeds.push(take(arg, i, rest));
        i += 1;
        break;
      case '--pin':
        out.pin = take(arg, i, rest);
        i += 1;
        break;
      case '--client':
        out.client = take(arg, i, rest);
        i += 1;
        break;
      case '--all':
        out.all = true;
        break;
      case '-h':
      case '--help':
        out.command = 'help';
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return out;
}

function parsePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be an integer >= 1, got ${value}`);
  }
  return n;
}

function parseEnvFile(file) {
  const vars = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function loadSeedConfig(args) {
  const envPath = args.envFile
    ? path.resolve(process.cwd(), args.envFile)
    : DEFAULT_ENV_FILE;
  let envVars = {};
  if (fs.existsSync(envPath)) {
    envVars = parseEnvFile(envPath);
  } else if (args.envFile) {
    throw new Error(`env file not found: ${envPath}`);
  }

  const byIndex = new Map();
  for (const [key, value] of Object.entries(envVars)) {
    const match = SEED_ENV_RE.exec(key);
    if (!match) continue;
    const phrase = String(value).trim();
    if (!phrase) continue;
    byIndex.set(Number(match[1]), phrase);
  }

  args.seeds.forEach((seed, i) => {
    const phrase = seed.trim();
    if (phrase) byIndex.set(i + 1, phrase);
  });

  const pin = (args.pin && String(args.pin).trim()) || envVars.PACTO_DEMO_PIN?.trim() || null;
  const appRemote =
    envVars.PACTO_APP_REMOTE?.trim() ||
    process.env.PACTO_APP_REMOTE?.trim() ||
    DEFAULT_APP_REMOTE;
  return { byIndex, pin, envPath, loaded: fs.existsSync(envPath), appRemote };
}

function readPidsFile() {
  if (!fs.existsSync(PIDS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writePidsFile(state) {
  fs.writeFileSync(PIDS_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function stopPid(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

function killPid(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

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

async function cmdDown({ quiet = false } = {}) {
  const state = readPidsFile();
  if (!state) {
    if (!quiet) log('no pids.json — nothing to stop');
    return;
  }
  await stopClients(state, { quiet });
  if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
  if (!quiet) log('stopped. storage was not wiped.');
}

function cmdStatus() {
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
      log(
        `  client ${client.index}: ${alive} pid=${client.pid} ${client.identifier} ` +
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

function listWipeableStorageDirs() {
  const root = appDataRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && IDENTIFIER_RE.test(entry.name))
    .map(entry => path.join(root, entry.name));
}

function wipeDir(dir) {
  const resolved = assertWipePath(dir);
  if (!fs.existsSync(resolved)) {
    log(`already absent: ${resolved}`);
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  log(`wiped ${resolved}`);
}

function cmdWipe(args) {
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

function ensureAppClone(remote) {
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

function resolveRef(args, appRepo, remote) {
  if (args.pr && args.branch) {
    throw new Error('--pr and --branch are mutually exclusive');
  }
  if (!args.pr && !args.branch) {
    throw new Error('up requires --pr <n> or --branch <name>');
  }

  const repo = githubRepoSlug(remote);

  if (args.pr) {
    const pr = parsePositiveInt(args.pr, '--pr');
    if (!commandExists('gh')) {
      throw new Error('gh is required for --pr (https://cli.github.com/)');
    }
    const raw = run('gh', [
      'pr',
      'view',
      String(pr),
      '--repo',
      repo,
      '--json',
      'headRefOid,headRefName,url,title',
    ]);
    const prInfo = JSON.parse(raw);
    run('git', ['fetch', 'origin', `pull/${pr}/head`], {
      cwd: appRepo,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const sha = prInfo.headRefOid || run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: appRepo });
    return {
      kind: 'pr',
      pr,
      sha,
      name: prInfo.headRefName,
      slug: `pr-${pr}`,
      label: `PR #${pr} (${prInfo.headRefName})`,
      url: prInfo.url,
      repo,
    };
  }

  const branch = String(args.branch).trim();
  if (!branch) throw new Error('--branch must be a non-empty name');
  run('git', ['fetch', 'origin', branch], {
    cwd: appRepo,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const sha = run('git', ['rev-parse', `origin/${branch}`], { cwd: appRepo });
  return {
    kind: 'branch',
    branch,
    sha,
    name: branch,
    slug: slugForRef(branch),
    label: `${repo}@${branch}`,
    repo,
  };
}

function ensureWorktree(ref, appRepo) {
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
  return worktreePath;
}

function pnpmInstall(worktreePath) {
  log('pnpm install --frozen-lockfile');
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreePath, stdio: ['ignore', 'inherit', 'inherit'] });
}

function readWindowTemplate(worktreePath) {
  const confPath = path.join(worktreePath, 'src-tauri', 'tauri.conf.json');
  if (!fs.existsSync(confPath)) {
    throw new Error(`missing ${confPath}`);
  }
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const window = conf.app?.windows?.[0] ? { ...conf.app.windows[0] } : {
    minWidth: 400,
    width: 1000,
    minHeight: 400,
    height: 800,
    resizable: true,
    maximized: true,
    visible: true,
  };
  return window;
}

function tauriOverlay(index, ports, windowTemplate) {
  const identifier = identifierForClient(index);
  assertSafePorts(ports);
  const title = `Pacto Demo ${index}`;
  return {
    identifier,
    productName: title,
    build: { devUrl: `http://localhost:${ports.devServer}` },
    app: { windows: [{ ...windowTemplate, title }] },
  };
}

function launchEnv(index, ports, mnemonic, pin) {
  const env = { ...process.env };
  env.PACTO_DEV_PORT = String(ports.devServer);
  env.PACTO_DEV_HMR_PORT = String(ports.hmr);
  env.PACTO_MCP_BRIDGE_PORT = String(ports.mcpBridge);
  env.PACTO_ALLOW_TEST_AUTH = '1';
  env.CARGO_TARGET_DIR = path.join(TARGETS_DIR, String(index));
  if (mnemonic) env.PACTO_DEV_LOGIN_MNEMONIC = mnemonic;
  if (pin) env.PACTO_DEV_LOGIN_PIN = pin;
  // Isolation is identifier-only. A missing sandbox root can fall through
  // to the real io.pacto app-data directory — never set these.
  delete env.PACTO_TEST_SANDBOX_ROOT;
  delete env.PACTO_DEV_WORLD;
  return env;
}

function spawnClient({ index, worktreePath, overlay, env, logPath }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(env.CARGO_TARGET_DIR, { recursive: true });
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(
    'pnpm',
    ['tauri', 'dev', '-f', 'local-relay-tls', '--config', JSON.stringify(overlay)],
    {
      cwd: worktreePath,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  fs.closeSync(logFd);
  child.unref();
  return child.pid;
}

async function waitUntilReady({ pid, ports, logPath, timeoutMs }) {
  const start = Date.now();
  let devUp = false;
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) {
      const tail = tailLog(logPath);
      throw new Error(
        `client process ${pid} exited before becoming ready. See ${logPath}` +
          (tail ? `:\n${tail}` : ''),
      );
    }
    if (!devUp && (await isPortListening(ports.devServer))) {
      devUp = true;
      log(`  dev server listening on :${ports.devServer}`);
    }
    if (devUp && (await isPortListening(ports.mcpBridge))) {
      log(`  app ready (mcp bridge :${ports.mcpBridge})`);
      return;
    }
    await sleep(PORT_POLL_MS);
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for client pid ${pid} ` +
      `(dev :${ports.devServer}, mcp :${ports.mcpBridge}). See ${logPath}`,
  );
}

function tailLog(logPath, lines = 40) {
  if (!fs.existsSync(logPath)) return '';
  const text = fs.readFileSync(logPath, 'utf8').trim();
  if (!text) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

async function cmdUp(args) {
  const clients = parsePositiveInt(args.clients, '--clients');
  if (clients > MAX_CLIENTS) {
    throw new Error(`--clients must be <= ${MAX_CLIENTS}, got ${clients}`);
  }
  const seedConfig = loadSeedConfig(args);
  const pin = seedConfig.pin;
  if (seedConfig.loaded) {
    log(`seeds: ${seedConfig.envPath} (${seedConfig.byIndex.size} phrase(s))`);
  } else {
    log(`seeds: no .env at ${seedConfig.envPath} (copy .env.example to .env); extra clients stay fresh`);
  }

  if (args.pr && args.branch) {
    throw new Error('--pr and --branch are mutually exclusive');
  }
  if (!args.pr && !args.branch) {
    throw new Error('up requires --pr <n> or --branch <name>');
  }

  for (let i = 1; i <= clients; i++) {
    identifierForClient(i);
    portsForIndex(i);
    storageDirForClient(i);
  }

  const existing = readPidsFile();
  if (existing?.clients?.some(c => isAlive(c.pid))) {
    log('stopping previous deployer session (storage kept)');
    await cmdDown({ quiet: true });
  } else if (existing) {
    if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
  }

  const appRepo = ensureAppClone(seedConfig.appRemote);
  const ref = resolveRef(args, appRepo, seedConfig.appRemote);
  log(`checkout ${ref.repo} ${ref.label} @ ${ref.sha.slice(0, 12)}`);
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

    if (!(await allPortsFree(ports))) {
      throw new Error(
        `ports for client ${i} are in use ` +
          `(${ports.devServer}/${ports.hmr}/${ports.mcpBridge}). ` +
          `Stop the occupant or run: node pacto-demo.mjs down`,
      );
    }

    const logPath = path.join(LOGS_DIR, `client-${i}.log`);
    const env = launchEnv(i, ports, mnemonic, pin);
    if (env.PACTO_TEST_SANDBOX_ROOT || env.PACTO_DEV_WORLD) {
      throw new Error('internal error: sandbox env leaked into launch');
    }

    const kind = mnemonic ? 'seeded account' : 'fresh session (no mnemonic)';
    log(`launching client ${i} ${identifier} :${ports.devServer} — ${kind}`);
    const pid = spawnClient({ index: i, worktreePath, overlay, env, logPath });
    state.clients.push({
      index: i,
      identifier,
      pid,
      ports,
      log: logPath,
      seeded: Boolean(mnemonic),
      storage: storageDirForClient(i),
    });
    writePidsFile(state);

    log(`  pid ${pid}, waiting for compile (log: ${logPath})`);
    await waitUntilReady({ pid, ports, logPath, timeoutMs: DEFAULT_READY_TIMEOUT_MS });
  }

  writePidsFile(state);
  log('');
  log(`launched ${clients} client(s). Storage persists until wipe.`);
  log('  node pacto-demo.mjs status');
  log('  node pacto-demo.mjs down');
  log('  node pacto-demo.mjs wipe --client 1');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error('');
    console.error(USAGE);
    process.exit(1);
  }

  try {
    switch (args.command) {
      case 'help':
        log(USAGE);
        break;
      case 'up':
        await cmdUp(args);
        break;
      case 'down':
        await cmdDown();
        break;
      case 'status':
        cmdStatus();
        break;
      case 'wipe':
        cmdWipe(args);
        break;
      default:
        throw new Error(`unknown command '${args.command}'`);
    }
  } catch (err) {
    fail(err.message);
  }
}

await main();
