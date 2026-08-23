import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const DEPLOYER_DIR = path.resolve(path.dirname(__filename), '..', '..');
export const APP_CACHE = path.join(DEPLOYER_DIR, '.cache', 'pacto-app');
export const DEFAULT_APP_REMOTE = 'https://github.com/covenant-gov/pacto-app.git';

export const WORKTREES_DIR = path.join(DEPLOYER_DIR, 'worktrees');
export const TARGETS_DIR = path.join(DEPLOYER_DIR, 'targets');
export const LOGS_DIR = path.join(DEPLOYER_DIR, 'logs');
export const BACKUPS_DIR = path.join(DEPLOYER_DIR, 'backups');
export const PIDS_FILE = path.join(DEPLOYER_DIR, 'pids.json');

export const IDENTIFIER_RE = /^io\.pacto\.demo\.[1-9][0-9]*$/;
export const FORBIDDEN_IDENTIFIERS = new Set(['io.pacto', 'io.pacto.demo']);

export const BASE_DEV_SERVER = 1420;
export const BASE_HMR = 1421;
export const BASE_MCP_BRIDGE = 9223;
export const PORT_STRIDE = 10;
export const BRIDGE_STRIDE = 100;
export const MAX_CLIENTS = 29;
export const UNSAFE_BROWSER_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

export const DEFAULT_READY_TIMEOUT_MS = Number(process.env.PACTO_DEMO_READY_TIMEOUT_MS) || 15 * 60 * 1000;
export const STOP_GRACE_MS = 5_000;
export const PORT_POLL_MS = 1_000;
export const DEFAULT_ENV_FILE = path.join(DEPLOYER_DIR, '.env');
export const SEED_ENV_RE = /^PACTO_DEMO_SEED_([1-9][0-9]*)$/;
export const DEFAULT_DEMO_PIN = '123456';
export const DEFAULT_APP_BRANCH = 'main';
/** pacto-app debug secrets forwarded from this repo's `.env` into `tauri dev`. */
export const APP_OPERATOR_ENV_KEYS = [
  'ALCHEMY_RPC_KEY',
  'POCKET_RPC_KEY',
  'VITE_WALLET_RPC_DOCS_URL',
  'PIMLICO_API_KEY',
  'BUNDLER_RPC_URL',
  'PACTO_ERC4337_ACCOUNT_IMPL',
  'PACTO_TRUSTED_RELAYS',
  'KLIPY_API_KEY',
];
export const DEMO_SQUAD_NAME_PREFIX = 'squad-test';
export const DEMO_SQUAD_NETWORK = 'sepolia';
export const DEMO_SQUAD_TAGS = ['test', 'demo', 'alpha'];
export const NATO_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu',
];
export const MCP_WINDOW = 'main';
export const MCP_JS_TIMEOUT_MS = 7_000;
export const MCP_INVOKE_TIMEOUT_MS = 45_000;
export const SESSION_WAIT_MS = 30_000;
export const PIN_UNLOCK_WAIT_MS = 15_000;
export const SQUAD_RETRY_MS = 30_000;
export const SQUAD_WELCOME_WAIT_MS = 45_000;
export const SQUAD_KEYPACKAGE_WAIT_MS = 20_000;
export const SQUAD_ACCEPT_UI_WAIT_MS = 12_000;
export const CANCEL_BROADCAST_MS = 15_000;
export const MESSAGE_ID_WAIT_MS = 15_000;
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

export function formatDemoStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function parsePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be an integer >= 1, got ${value}`);
  }
  return n;
}

function trimRefValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

/** `PR=0` / `--pr 0` means pacto-app `main`, not a GitHub pull request. */
export function isMainPrSentinel(value) {
  return trimRefValue(value) === '0';
}

/**
 * Resolve `--pr` / `--branch` (and `PR=` / `BRANCH=` from `.env`).
 * `PR=0` is not a pull request: with no branch it checks out `main`.
 */
export function normalizeLaunchRef(args) {
  const rawPr = trimRefValue(args?.pr);
  const rawBranch = trimRefValue(args?.branch);
  const prSentinel = isMainPrSentinel(rawPr);
  const prSet = rawPr !== '' && !prSentinel;
  const branchSet = rawBranch !== '';

  if (prSet && branchSet) {
    throw new Error('--pr and --branch are mutually exclusive (also PR= and BRANCH= in .env)');
  }
  if (prSet) {
    return { pr: String(parsePositiveInt(rawPr, '--pr')), branch: null };
  }
  if (branchSet) {
    return { pr: null, branch: rawBranch };
  }
  if (prSentinel) {
    return { pr: null, branch: DEFAULT_APP_BRANCH };
  }
  throw new Error(
    'up requires --pr <n> (0 = pacto-app main) or --branch <name> (or PR= / BRANCH= in .env)',
  );
}

export function operatorEnvFromVars(vars) {
  const out = {};
  for (const key of APP_OPERATOR_ENV_KEYS) {
    const value = vars?.[key];
    if (value == null) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }
  return out;
}

export function applyOperatorEnv(env, operatorEnv) {
  for (const [key, value] of Object.entries(operatorEnv ?? {})) {
    if (!APP_OPERATOR_ENV_KEYS.includes(key)) continue;
    if (value == null || String(value).trim() === '') continue;
    const current = env[key];
    if (current != null && String(current).trim() !== '') continue;
    env[key] = String(value).trim();
  }
  return env;
}

export function parseEnvFile(file) {
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

export function loadSeedConfig(args) {
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
    operatorEnv: operatorEnvFromVars(envVars),
    pr: envVars.PR?.trim() || null,
    branch: envVars.BRANCH?.trim() || null,
    clients: envVars.CLIENTS?.trim() || null,
  };
}

export function demoPin(args) {
  const seedConfig = loadSeedConfig({
    seeds: args?.seeds ?? [],
    pin: args?.pin ?? null,
    envFile: args?.envFile ?? null,
  });
  return (seedConfig.pin && String(seedConfig.pin).trim()) || DEFAULT_DEMO_PIN;
}

export function usageText() {
  return `Pacto demo deployer — isolated parallel clients (never touches io.pacto)

PRs and branches are from https://github.com/covenant-gov/pacto-app
(cloned into .cache/pacto-app on first up).

Usage:
  cp .env.example .env          # then set PR, CLIENTS, PACTO_DEMO_SEED_N, ALCHEMY_RPC_KEY, ...
  node pacto-demo.mjs up        # launch, login/create, backup seed, profile
  node pacto-demo.mjs up-light  # same as: up --light (Commons user broadcast after launch)
  node pacto-demo.mjs up-full   # same as: up --full (broadcast, DMs + squad after launch)
  node pacto-demo.mjs dm        # client 1 DMs others; they reply (clients must be up)
  node pacto-demo.mjs squad     # create, invite, bravo accepts (Sepolia, Commons #test)
  node pacto-demo.mjs squad --name my-squad
  node pacto-demo.mjs squad --all
  node pacto-demo.mjs squad --join
  node pacto-demo.mjs up --pr <n> --clients <n>
  node pacto-demo.mjs up --pr 0 --clients <n>   # pacto-app main
  node pacto-demo.mjs up --branch <name> --clients <n>
  node pacto-demo.mjs reload    # fetch latest PR/branch commits and rebuild (storage kept)
  node pacto-demo.mjs down
  node pacto-demo.mjs down --wipe
  node pacto-demo.mjs status
  node pacto-demo.mjs wipe --client <n>
  node pacto-demo.mjs wipe --all

Options:
  --pr <n>              GitHub PR number on covenant-gov/pacto-app; 0 = main (mutually exclusive with --branch)
  --branch <name>       Remote branch on covenant-gov/pacto-app (mutually exclusive with --pr)
  --clients <n>         Number of desktop clients to launch (1..${MAX_CLIENTS})
  --env <path>          Env file with PR/CLIENTS/PACTO_DEMO_SEED_N and pacto-app operator keys (default: .env next to this script)
  --seed "<phrase>"     Repeatable; overrides PACTO_DEMO_SEED_1, then _2, ...
  --pin <pin>           Dev autologin PIN (default: PACTO_DEMO_PIN or 123456)
  --name <name>         Squad display name (default: squad-test-<n>)
  --wipe                After down: wipe every io.pacto.demo.<n> directory (storage is kept otherwise)
  --client <n>          Wipe storage for io.pacto.demo.<n> only
  --light               After up: also run Commons user broadcast
  --full                After up: also run broadcast, DMs and squad (client 1 invites client 2)
  --all                 wipe: every demo storage dir; squad: invite all other live clients
  --join                squad: accept pending invite (latest creator squad, or --name)

Defaults (CLI overrides .env):
  PR / BRANCH / CLIENTS in .env (PR=0 → pacto-app main)

Makefile:
  make up
  make up-light
  make up-full
  make dm
  make squad
  make squad NAME=my-squad
  make squad-all
  make squad-join
  make reload
  make down
  make down-wipe
  make wipe CLIENT=1
  make wipe-all
`;
}
