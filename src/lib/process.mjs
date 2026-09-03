import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BASE_DEV_SERVER,
  BASE_HMR,
  BASE_MCP_BRIDGE,
  BRIDGE_STRIDE,
  FORBIDDEN_IDENTIFIERS,
  IDENTIFIER_RE,
  LOOPBACK_HOSTS,
  PIDS_FILE,
  PORT_STRIDE,
  UNSAFE_BROWSER_PORTS,
} from './config.mjs';

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function log(message) {
  console.log(message);
}

export function run(cmd, args, opts = {}) {
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

export function commandExists(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function slugForRef(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '-');
}

export function identifierForClient(index) {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`client index must be an integer >= 1, got ${index}`);
  }
  const identifier = `io.pacto.demo.${index}`;
  assertSafeIdentifier(identifier);
  return identifier;
}

export function assertSafeIdentifier(identifier) {
  if (FORBIDDEN_IDENTIFIERS.has(identifier)) {
    throw new Error(`refusing identifier '${identifier}' (reserved for the main client)`);
  }
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`refusing identifier '${identifier}' (must match io.pacto.demo.<n> with n >= 1)`);
  }
}

export function portsForIndex(index) {
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

export function assertSafePorts(ports) {
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

export function appDataRoot() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    default:
      return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

export function storageDirForClient(index) {
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

export function assertWipePath(dir) {
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

export async function isPortFree(port) {
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

export async function isPortListening(port) {
  const results = await Promise.all(LOOPBACK_HOSTS.map(host => connectOnce(port, host)));
  return results.some(Boolean);
}

export async function allPortsFree(ports) {
  const [devServer, hmr, mcpBridge] = await Promise.all([
    isPortFree(ports.devServer),
    isPortFree(ports.hmr),
    isPortFree(ports.mcpBridge),
  ]);
  return devServer && hmr && mcpBridge;
}

export function readPidsFile() {
  if (!fs.existsSync(PIDS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writePidsFile(state) {
  fs.writeFileSync(PIDS_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function mergeClientRow(state, row) {
  const clients = (state?.clients ?? []).filter(c => c.index !== row.index);
  clients.push(row);
  clients.sort((a, b) => a.index - b.index);
  return { ...state, clients };
}

export function stopPid(pid) {
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

export function killPid(pid) {
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

export function listWipeableStorageDirs() {
  const root = appDataRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && IDENTIFIER_RE.test(entry.name))
    .map(entry => path.join(root, entry.name));
}

export function wipeDir(dir) {
  const resolved = assertWipePath(dir);
  if (!fs.existsSync(resolved)) {
    log(`already absent: ${resolved}`);
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  log(`wiped ${resolved}`);
}
