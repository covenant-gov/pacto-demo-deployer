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
const DEFAULT_DEMO_PIN = '123456';
const NATO_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu',
];
const MCP_WINDOW = 'main';
const MCP_JS_TIMEOUT_MS = 7_000;
const MCP_INVOKE_TIMEOUT_MS = 45_000;
const SESSION_WAIT_MS = 30_000;
const PIN_UNLOCK_WAIT_MS = 15_000;
const SQUAD_RETRY_MS = 30_000;
const CANCEL_BROADCAST_MS = 15_000;
const MESSAGE_ID_WAIT_MS = 15_000;

const USAGE = `Pacto demo deployer — isolated parallel clients (never touches io.pacto)

PRs and branches are from https://github.com/covenant-gov/pacto-app
(cloned into .cache/pacto-app on first up).

Usage:
  cp .env.example .env          # then set PR, CLIENTS, PACTO_DEMO_SEED_1, ...
  node pacto-demo.mjs up
  node pacto-demo.mjs up --pr <n> --clients <n>
  node pacto-demo.mjs up --branch <name> --clients <n>
  node pacto-demo.mjs reload    # fetch latest PR/branch commits and rebuild (storage kept)
  node pacto-demo.mjs down
  node pacto-demo.mjs down --wipe
  node pacto-demo.mjs status
  node pacto-demo.mjs wipe --client <n>
  node pacto-demo.mjs wipe --all

Options:
  --pr <n>              GitHub PR number on covenant-gov/pacto-app (mutually exclusive with --branch)
  --branch <name>       Remote branch on covenant-gov/pacto-app (mutually exclusive with --pr)
  --clients <n>         Number of desktop clients to launch (1..${MAX_CLIENTS})
  --env <path>          Env file with PR/CLIENTS/PACTO_DEMO_SEED_N (default: .env next to this script)
  --seed "<phrase>"     Repeatable; overrides PACTO_DEMO_SEED_1, then _2, ...
  --pin <pin>           Dev autologin PIN (default: PACTO_DEMO_PIN or 123456)
  --wipe                After down: wipe every io.pacto.demo.<n> directory (storage is kept otherwise)
  --client <n>          Wipe storage for io.pacto.demo.<n> only
  --all                 Wipe every io.pacto.demo.<n> directory

Defaults (CLI overrides .env):
  PR / BRANCH / CLIENTS in .env

Makefile:
  make up
  make reload
  make down
  make down-wipe
  make wipe CLIENT=1
  make wipe-all
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

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

function bindOnce(port, host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', err => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve('busy');
      else resolve('unavailable');
    });
    server.listen(port, host, () => {
      server.close(() => resolve('free'));
    });
  });
}

async function isPortFree(port) {
  const results = await Promise.all(LOOPBACK_HOSTS.map(host => bindOnce(port, host)));
  if (results.includes('busy')) return false;
  return results.some(r => r === 'free');
}

function connectOnce(port, host) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function isPortListening(port) {
  const results = await Promise.all(LOOPBACK_HOSTS.map(host => connectOnce(port, host)));
  return results.some(Boolean);
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
    wipe: false,
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
      case '--wipe':
        out.wipe = true;
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
  return {
    byIndex,
    pin,
    envPath,
    loaded: fs.existsSync(envPath),
    appRemote,
    pr: envVars.PR?.trim() || null,
    branch: envVars.BRANCH?.trim() || null,
    clients: envVars.CLIENTS?.trim() || null,
  };
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

async function cmdDown({ quiet = false, wipe = false } = {}) {
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
    throw new Error('--pr and --branch are mutually exclusive (also PR= and BRANCH= in .env)');
  }
  if (!args.pr && !args.branch) {
    throw new Error('up requires --pr <n> or --branch <name> (or PR= / BRANCH= in .env)');
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

function demoNameForIndex(index) {
  const i = index - 1;
  const word = NATO_WORDS[i % NATO_WORDS.length];
  const round = Math.floor(i / NATO_WORDS.length);
  return round === 0 ? `${word}-test` : `${word}-test-${round + 1}`;
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapExecuteJs(response, label) {
  if (!response) throw new Error(`${label}: empty execute_js response`);
  if (response.success === false) {
    throw new Error(`${label} failed: ${response.error || JSON.stringify(response)}`);
  }
  if (Object.prototype.hasOwnProperty.call(response, 'data')) {
    return parseJsonMaybe(response.data);
  }
  return parseJsonMaybe(response);
}

async function withMcp(port, fn) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Node WebSocket is required (Node 22+)');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp ws :${port} connect timed out`)), 8_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`mcp ws :${port} connection failed`));
    });
  });
  ws.addEventListener('message', ev => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve(msg);
  });
  const bridge = {
    port,
    async sendCommand(command, timeoutMs = MCP_JS_TIMEOUT_MS) {
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const payload = { ...command, id };
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`mcp command ${command.command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: msg => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
        ws.send(JSON.stringify(payload));
      });
      return response;
    },
  };
  try {
    return await fn(bridge);
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

async function executeJs(bridge, script, timeoutMs = MCP_JS_TIMEOUT_MS) {
  const response = await bridge.sendCommand(
    {
      command: 'execute_js',
      args: { script, windowLabel: MCP_WINDOW },
    },
    timeoutMs,
  );
  return unwrapExecuteJs(response, 'execute_js');
}

async function waitForTauri(bridge, timeoutMs = SESSION_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await executeJs(
        bridge,
        '(() => !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke))()',
      );
      if (ready === true || ready === 'true') return;
    } catch {
      // webview not ready yet
    }
    await sleep(250);
  }
  throw new Error(`webview __TAURI__ not ready on mcp :${bridge.port}`);
}

async function invokeTauri(bridge, command, args = {}, timeoutMs = MCP_INVOKE_TIMEOUT_MS) {
  await waitForTauri(bridge);
  const slot = `__demo_invoke_${command}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startScript = `(() => {
    const slot = ${JSON.stringify(slot)};
    window[slot] = { done: false, error: null, result: null };
    Promise.resolve(window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))
      .then((r) => { window[slot].result = r; window[slot].done = true; })
      .catch((e) => {
        window[slot].error = (e && e.message) ? e.message : String(e);
        window[slot].done = true;
      });
    return { started: true };
  })()`;
  await executeJs(bridge, startScript);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollScript = `(() => {
      const s = window[${JSON.stringify(slot)}];
      if (!s) return { done: false };
      if (!s.done) return { done: false };
      if (s.error) return { done: true, ok: false, error: s.error };
      return { done: true, ok: true, result: s.result };
    })()`;
    const polled = await executeJs(bridge, pollScript);
    if (polled && polled.done) {
      if (!polled.ok) {
        throw new Error(`invoke ${command} failed: ${polled.error}`);
      }
      return polled.result;
    }
    await sleep(250);
  }
  throw new Error(`invoke ${command} timed out after ${timeoutMs}ms`);
}

async function pinUnlockUiState(bridge) {
  try {
    return await executeJs(
      bridge,
      `(() => {
        const title = document.querySelector('.pin-title')?.textContent?.trim() || '';
        const login = !!document.querySelector('.login-container');
        return { title, login };
      })()`,
    );
  } catch {
    return null;
  }
}

async function pasteUnlockPin(bridge, pin) {
  const script = `(() => {
    const title = document.querySelector('.pin-title')?.textContent?.trim() || '';
    if (title !== 'Enter your PIN') return { ok: false, reason: 'not-unlock', title };
    const inputs = Array.from(document.querySelectorAll('input.pin-digit'));
    if (!inputs.length) return { ok: false, reason: 'no-input' };
    const pin = ${JSON.stringify(pin)};
    const first = inputs[0];
    first.focus();
    let filled = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text', pin);
      dt.setData('text/plain', pin);
      first.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }));
      filled = inputs.every((el, i) => el.value === pin[i]);
    } catch {
      filled = false;
    }
    if (!filled) {
      pin.split('').forEach((digit, i) => {
        const el = inputs[i];
        if (!el) return;
        el.focus();
        el.value = digit;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    return { ok: true };
  })()`;
  await executeJs(bridge, script);
}

async function unlockPinUiIfNeeded(bridge, pin) {
  if (!pin) return;
  const appearDeadline = Date.now() + 5_000;
  let sawUnlock = false;
  while (Date.now() < appearDeadline) {
    const state = await pinUnlockUiState(bridge);
    if (!state) {
      await sleep(250);
      continue;
    }
    if (!state.login) return;
    if (state.title === 'Enter your PIN') {
      sawUnlock = true;
      break;
    }
    if (state.title) return;
    await sleep(250);
  }
  if (!sawUnlock) return;

  let lastPaste = 0;
  const goneDeadline = Date.now() + PIN_UNLOCK_WAIT_MS;
  while (Date.now() < goneDeadline) {
    const state = await pinUnlockUiState(bridge);
    if (!state) {
      await sleep(400);
      continue;
    }
    if (!state.login || state.title !== 'Enter your PIN') return;
    if (Date.now() - lastPaste > 1_500) {
      try {
        await pasteUnlockPin(bridge, pin);
        lastPaste = Date.now();
      } catch {
        // retry while the unlock form is still up
      }
    }
    await sleep(400);
  }
}

async function reloadWebview(bridge, pin) {
  try {
    await executeJs(bridge, '(() => { window.location.reload(); return true; })()');
  } catch {
    // reload can tear down the executing context
  }
  await sleep(1_500);
  await waitForTauri(bridge);
  await unlockPinUiIfNeeded(bridge, pin);
}

async function tryCurrentAccount(bridge) {
  try {
    const npub = await invokeTauri(bridge, 'get_current_account');
    if (typeof npub === 'string' && npub.startsWith('npub1')) return npub;
  } catch {
    return null;
  }
  return null;
}

async function waitForAccount(bridge, timeoutMs = SESSION_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const npub = await tryCurrentAccount(bridge);
    if (npub) return npub;
    await sleep(1_000);
  }
  return null;
}

async function createHeadlessAccount(bridge, pin) {
  const keys = await invokeTauri(bridge, 'create_account');
  const encrypted = await invokeTauri(bridge, 'encrypt', { input: keys.private, password: pin });
  await invokeTauri(bridge, 'set_pkey', { pkey: encrypted });
  if (keys.evm_private_key && keys.evm_address) {
    const evmEnc = await invokeTauri(bridge, 'encrypt', {
      input: keys.evm_private_key,
      password: pin,
    });
    await invokeTauri(bridge, 'set_evm_pkey', { evmPkey: evmEnc });
    await invokeTauri(bridge, 'set_evm_address', { address: keys.evm_address });
  }
  await invokeTauri(bridge, 'connect');
  try {
    await invokeTauri(bridge, 'regenerate_device_keypackage', { cache: true });
  } catch {
    // keypackage publish is best-effort; squad loop retries
  }
  await reloadWebview(bridge, pin);
  const npub = await waitForAccount(bridge, 10_000);
  if (!npub) throw new Error('create_account succeeded but no current account after reload');
  return npub;
}

async function unlockWithPin(bridge, pin) {
  const encryptedKey = await invokeTauri(bridge, 'get_pkey');
  if (!encryptedKey) return null;
  const decrypted = await invokeTauri(bridge, 'decrypt', {
    ciphertext: encryptedKey,
    password: pin,
  });
  await invokeTauri(bridge, 'login', { importKey: decrypted });
  return waitForAccount(bridge, 10_000);
}

async function ensureSession(bridge, pin, seeded) {
  await waitForTauri(bridge);
  let npub = null;
  if (seeded) {
    npub = await waitForAccount(bridge, SESSION_WAIT_MS);
  } else {
    npub = await tryCurrentAccount(bridge);
  }
  if (!npub) {
    try {
      npub = await unlockWithPin(bridge, pin);
    } catch {
      // no stored key, or wrong PIN — create instead
    }
  }
  if (!npub) {
    log('    no session; creating a fresh account');
    npub = await createHeadlessAccount(bridge, pin);
  }
  await unlockPinUiIfNeeded(bridge, pin);
  return npub;
}

async function lastOutboundMessageId(bridge, peerNpub, content) {
  const deadline = Date.now() + MESSAGE_ID_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const msgs = await invokeTauri(bridge, 'get_message_views', {
        chatId: peerNpub,
        limit: 20,
        offset: 0,
        virtualBucketFilter: null,
      });
      const list = Array.isArray(msgs) ? msgs : [];
      const hit = [...list]
        .reverse()
        .find(
          m =>
            m &&
            m.mine &&
            m.content === content &&
            m.id &&
            !String(m.id).startsWith('pending-'),
        );
      if (hit) return hit.id;
    } catch {
      // chat may not exist yet
    }
    await sleep(500);
  }
  return null;
}

async function publishDemoBroadcast(bridge, npub, name) {
  try {
    const active = await invokeTauri(bridge, 'commons_get_local_active', {
      subject: 'user',
      subjectId: npub,
    });
    if (active) {
      await invokeTauri(bridge, 'commons_cancel_broadcast', {
        subject: 'user',
        subjectId: npub,
      });
    }
  } catch {
    // nothing active
  }
  await invokeTauri(bridge, 'commons_publish_broadcast', {
    input: {
      subject: 'user',
      message: name,
      durationHours: 24,
      tags: ['test'],
      audience: 'new_user',
    },
  });
}

async function currentProfileName(bridge, npub) {
  try {
    const profile = await invokeTauri(bridge, 'get_profile', { npub });
    return typeof profile?.name === 'string' ? profile.name : '';
  } catch {
    return '';
  }
}

async function setupDemoName(client, pin) {
  const name = demoNameForIndex(client.index);
  log(`  client ${client.index}: session + profile ${name}`);
  const npub = await withMcp(client.ports.mcpBridge, async bridge => {
    const account = await ensureSession(bridge, pin, client.seeded);
    const existing = await currentProfileName(bridge, account);
    if (existing === name) {
      log(`    name already ${name}; skipping profile update`);
      return account;
    }
    try {
      await invokeTauri(bridge, 'connect');
    } catch {
      // UI unlock / autologin may still be opening relays
    }
    try {
      await invokeTauri(bridge, 'update_profile', {
        name,
        avatar: '',
        banner: '',
        about: '',
      });
    } catch (err) {
      log(`    profile update skipped: ${err.message}`);
    }
    await reloadWebview(bridge, pin);
    return account;
  });
  client.name = name;
  client.npub = npub;
  log(`    ${name} ${npub}`);
}

async function runDemoOrchestration(clients, pin) {
  const named = clients.filter(c => c.npub);
  if (named.length === 0) {
    log('orchestration: no named clients, skipping');
    return;
  }

  log('loop 2: 24h Commons broadcasts');
  for (const client of named) {
    try {
      await withMcp(client.ports.mcpBridge, async bridge => {
        await publishDemoBroadcast(bridge, client.npub, client.name);
        await reloadWebview(bridge, pin);
      });
      client.broadcast = true;
      log(`  client ${client.index}: broadcast ${client.name}`);
    } catch (err) {
      log(`  client ${client.index}: broadcast failed: ${err.message}`);
    }
  }

  if (named.length < 2) return;
  const first = named.find(c => c.index === 1) || named[0];
  const others = named.filter(c => c !== first);

  log('loop 3: demo 1 DMs other clients');
  const outboundIds = new Map();
  await withMcp(first.ports.mcpBridge, async bridge => {
    for (const peer of others) {
      const content = `hello from ${first.name}`;
      try {
        await invokeTauri(bridge, 'message', {
          receiver: peer.npub,
          content,
          repliedTo: '',
          file: null,
          virtualBucket: null,
        });
        const id = await lastOutboundMessageId(bridge, peer.npub, content);
        if (id) outboundIds.set(peer.index, id);
        log(`  ${first.name} -> ${peer.name}${id ? ` (${id.slice(0, 12)}…)` : ''}`);
      } catch (err) {
        log(`  ${first.name} -> ${peer.name} failed: ${err.message}`);
      }
    }
  });

  log('loop 4: other clients reply to demo 1');
  for (const peer of others) {
    const content = `hello from ${peer.name}`;
    const repliedTo = outboundIds.get(peer.index) || '';
    try {
      await withMcp(peer.ports.mcpBridge, async bridge => {
        await invokeTauri(bridge, 'message', {
          receiver: first.npub,
          content,
          repliedTo,
          file: null,
          virtualBucket: null,
        });
      });
      log(`  ${peer.name} -> ${first.name}${repliedTo ? ' (reply)' : ''}`);
    } catch (err) {
      log(`  ${peer.name} -> ${first.name} failed: ${err.message}`);
    }
  }

  const second = named.find(c => c.index === 2) || others[0];
  if (!second) return;
  log(`loop 5: ${first.name} creates squad with ${second.name}`);
  const deadline = Date.now() + SQUAD_RETRY_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const groupId = await withMcp(first.ports.mcpBridge, async bridge => {
        return invokeTauri(bridge, 'create_group_chat', {
          groupName: 'demo-squad',
          memberIds: [second.npub],
        });
      });
      log(`  demo-squad ${typeof groupId === 'string' ? groupId.slice(0, 16) : groupId}`);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2_000);
    }
  }
  log(`  squad create failed: ${lastErr?.message || 'unknown error'}`);
}

async function cancelDemoBroadcast(client, { quiet = false } = {}) {
  if (!client?.npub || !isAlive(client.pid)) return;
  try {
    await withMcp(client.ports.mcpBridge, async bridge => {
      await invokeTauri(
        bridge,
        'commons_cancel_broadcast',
        { subject: 'user', subjectId: client.npub },
        CANCEL_BROADCAST_MS,
      );
    });
    if (!quiet) log(`client ${client.index}: cancelled broadcast`);
  } catch (err) {
    if (!quiet) log(`client ${client.index}: cancel broadcast failed: ${err.message}`);
  }
}

async function cmdUp(args) {
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
    const demoPin = (pin && String(pin).trim()) || DEFAULT_DEMO_PIN;
    try {
      await setupDemoName(row, demoPin);
    } catch (err) {
      log(`  client ${i}: name/session failed: ${err.message}`);
    }
    writePidsFile(state);
  }

  await runDemoOrchestration(state.clients, (pin && String(pin).trim()) || DEFAULT_DEMO_PIN);
  writePidsFile(state);
  log('');
  log(`launched ${clients} client(s). Storage persists until wipe.`);
  log('  node pacto-demo.mjs status');
  log('  node pacto-demo.mjs reload');
  log('  node pacto-demo.mjs down');
  log('  node pacto-demo.mjs down --wipe');
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
      case 'reload':
        await cmdUp(args);
        break;
      case 'down':
        await cmdDown({ wipe: args.wipe });
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
