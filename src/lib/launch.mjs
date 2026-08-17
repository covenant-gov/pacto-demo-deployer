import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyOperatorEnv, PORT_POLL_MS, TARGETS_DIR } from './config.mjs';
import {
  assertSafePorts,
  identifierForClient,
  isAlive,
  isPortListening,
  log,
  sleep,
} from './process.mjs';

export function readWindowTemplate(worktreePath) {
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

export function tauriOverlay(index, ports, windowTemplate) {
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

export function launchEnv(index, ports, mnemonic, pin, operatorEnv = {}) {
  const env = { ...process.env };
  env.PACTO_DEV_PORT = String(ports.devServer);
  env.PACTO_DEV_HMR_PORT = String(ports.hmr);
  env.PACTO_MCP_BRIDGE_PORT = String(ports.mcpBridge);
  env.PACTO_ALLOW_TEST_AUTH = '1';
  env.CARGO_TARGET_DIR = path.join(TARGETS_DIR, String(index));
  if (mnemonic) env.PACTO_DEV_LOGIN_MNEMONIC = mnemonic;
  if (pin) env.PACTO_DEV_LOGIN_PIN = pin;
  applyOperatorEnv(env, operatorEnv);
  delete env.PACTO_TEST_SANDBOX_ROOT;
  delete env.PACTO_DEV_WORLD;
  return env;
}

export function spawnClient({ index, worktreePath, overlay, env, logPath }) {
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

export function tailLog(logPath, lines = 40) {
  if (!fs.existsSync(logPath)) return '';
  const text = fs.readFileSync(logPath, 'utf8').trim();
  if (!text) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

export async function waitUntilReady({ pid, ports, logPath, timeoutMs }) {
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
