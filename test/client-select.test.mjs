import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOGS_DIR,
  clientLogPath,
  launchIndexes,
  loadSeedConfig,
  resolveRequiredClient,
} from '../src/lib/config.mjs';
import { mergeClientRow } from '../src/lib/process.mjs';
import { cmdLogs } from '../src/commands/lifecycle.mjs';

function writeEnv(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacto-demo-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, body);
  return file;
}

test('launchIndexes for up-client is only N, not 1..CLIENTS', () => {
  assert.deepEqual(launchIndexes({ onlyClient: 2, clients: 3 }), [2]);
  assert.deepEqual(launchIndexes({ clients: 3 }), [1, 2, 3]);
  assert.throws(() => launchIndexes({}), /up requires --clients/);
  assert.throws(() => launchIndexes({ onlyClient: 0 }), /--client/);
});

test('resolveRequiredClient prefers CLI over env', () => {
  assert.equal(
    resolveRequiredClient({
      cliValue: '2',
      envValue: '1',
      envLabel: 'CLIENT',
      error: 'missing',
    }),
    2,
  );
  assert.equal(
    resolveRequiredClient({
      cliValue: null,
      envValue: '2',
      envLabel: 'LOG_CLIENT',
      error: 'missing',
    }),
    2,
  );
  assert.throws(
    () =>
      resolveRequiredClient({
        cliValue: '',
        envValue: '',
        envLabel: 'CLIENT',
        error: 'up-client requires --client <n> or CLIENT in .env',
      }),
    /up-client requires/,
  );
});

test('loadSeedConfig reads CLIENT and LOG_CLIENT without logging seeds', () => {
  const envPath = writeEnv(`
CLIENTS=3
CLIENT=2
LOG_CLIENT=2
PACTO_DEMO_SEED_1="alpha alpha alpha"
PACTO_DEMO_SEED_2="bravo bravo bravo"
`);
  const cfg = loadSeedConfig({ envFile: envPath, seeds: [] });
  assert.equal(cfg.client, '2');
  assert.equal(cfg.logClient, '2');
  assert.equal(cfg.clients, '3');
  assert.equal(cfg.byIndex.get(1), 'alpha alpha alpha');
  assert.equal(cfg.byIndex.get(2), 'bravo bravo bravo');
});

test('mergeClientRow replaces one index and keeps siblings', () => {
  const merged = mergeClientRow(
    {
      clients: [
        { index: 1, pid: 11 },
        { index: 2, pid: 22 },
      ],
    },
    { index: 2, pid: 99 },
  );
  assert.deepEqual(
    merged.clients.map(c => [c.index, c.pid]),
    [
      [1, 11],
      [2, 99],
    ],
  );
});

test('cmdLogs requires LOG_CLIENT or --client', async () => {
  const envPath = writeEnv('CLIENTS=2\n');
  await assert.rejects(
    async () => cmdLogs({ client: null, envFile: envPath, seeds: [] }),
    /logs requires --client/,
  );
});

test('cmdLogs follows logs/client-<n>.log via tail -F', async () => {
  const envPath = writeEnv('LOG_CLIENT=29\n');
  const logPath = clientLogPath(29, LOGS_DIR);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, 'ready\n');
  const calls = [];
  try {
    await cmdLogs(
      { client: null, envFile: envPath, seeds: [] },
      {
        spawnFn(cmd, argv, opts) {
          calls.push({ cmd, argv, opts });
          const child = new EventEmitter();
          process.nextTick(() => child.emit('exit', 0, null));
          return child;
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'tail');
    assert.deepEqual(calls[0].argv, ['-F', logPath]);
    assert.equal(calls[0].opts.stdio, 'inherit');
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
